# dsh-pc-monitor — resident counter sampler (Windows).
#
# Supplies the readings Node cannot get from its own process: GPU engine
# utilization and available memory. Both live in the Windows performance
# counters (PDH) and both need a persistent process, because opening/comparing
# counters costs far more than a 2 s sampling budget.
#
# Temperature is deliberately absent: the only unprivileged source on Windows is
# the ACPI thermal-zone counter, which on this class of machine reports a coarse
# chassis value (measured 34.2 -> 34.7 C under 64% CPU load). A real CPU core
# temperature needs a kernel driver (LibreHardwareMonitor/HWiNFO, admin rights).
#
# Why a single PDH query instead of Get-Counter: Get-Counter fails the WHOLE call
# when any one GPU engine instance is stale ("a sample in the data is invalid"),
# which happens constantly because engines come and go with every process.
# One query with 300+ counters collects once and lets us skip the invalid ones.
# Measured: collect + read = 4-42 ms, where per-counter Get-Counter took 8 s.
#
# Output: one compact JSON line per sample on stdout, ~2 s cadence. The host
# (index.js) parses lines, keeps the newest frame, and restarts this process if
# it exits. Numbers use the invariant culture so no comma decimals.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$inv = [Globalization.CultureInfo]::InvariantCulture

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

/// <summary>Thin PDH wrapper: one query, many counters, per-counter validity.</summary>
public class PdhQuery : IDisposable
{
    [StructLayout(LayoutKind.Sequential)]
    struct PDH_FMT_COUNTERVALUE_DOUBLE { public uint CStatus; public double doubleValue; }

    [DllImport("pdh.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint PdhOpenQuery(string dataSource, IntPtr userData, out IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint PdhAddCounter(IntPtr query, string path, IntPtr userData, out IntPtr counter);
    [DllImport("pdh.dll", SetLastError = true)]
    static extern uint PdhCollectQueryData(IntPtr query);
    [DllImport("pdh.dll", SetLastError = true)]
    static extern uint PdhGetFormattedCounterValue(IntPtr counter, uint format, IntPtr type, out PDH_FMT_COUNTERVALUE_DOUBLE value);
    [DllImport("pdh.dll", SetLastError = true)]
    static extern uint PdhCloseQuery(IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    static extern uint PdhEnumObjectItems(string dataSource, string machine, string objectName,
        IntPtr counters, ref uint counterSize, IntPtr instances, ref uint instanceSize,
        uint detailLevel, uint flags);

    const uint PDH_FMT_DOUBLE = 0x00000200;
    const uint PDH_MORE_DATA = 0x800007D2;
    const uint PERF_DETAIL_WIZARD = 400;

    IntPtr _query;
    readonly List<IntPtr> _counters = new List<IntPtr>();

    public PdhQuery()
    {
        uint rc = PdhOpenQuery(null, IntPtr.Zero, out _query);
        if (rc != 0) throw new InvalidOperationException("PdhOpenQuery failed: " + rc);
    }

    /// <summary>
    /// Instance names of a multi-instance performance object.
    /// PDH returns a MULTI_SZ, which a marshalled StringBuilder truncates at the
    /// first NUL, so the buffer is walked by hand.
    /// </summary>
    public static string[] EnumInstances(string objectName)
    {
        uint counterSize = 0, instanceSize = 0;
        uint rc = PdhEnumObjectItems(null, null, objectName, IntPtr.Zero, ref counterSize, IntPtr.Zero, ref instanceSize, PERF_DETAIL_WIZARD, 0);
        if (rc != PDH_MORE_DATA && rc != 0) return new string[0];
        IntPtr counterBuf = Marshal.AllocHGlobal((int)(counterSize * 2 + 8));
        IntPtr instanceBuf = Marshal.AllocHGlobal((int)(instanceSize * 2 + 8));
        try
        {
            rc = PdhEnumObjectItems(null, null, objectName, counterBuf, ref counterSize, instanceBuf, ref instanceSize, PERF_DETAIL_WIZARD, 0);
            if (rc != 0) return new string[0];
            var names = new List<string>();
            long cursor = instanceBuf.ToInt64();
            while (true)
            {
                string name = Marshal.PtrToStringUni(new IntPtr(cursor));
                if (string.IsNullOrEmpty(name)) break;
                names.Add(name);
                cursor += (name.Length + 1) * 2;
            }
            return names.ToArray();
        }
        finally
        {
            Marshal.FreeHGlobal(counterBuf);
            Marshal.FreeHGlobal(instanceBuf);
        }
    }

    public bool AddCounter(string path)
    {
        IntPtr counter;
        uint rc = PdhAddCounter(_query, path, IntPtr.Zero, out counter);
        if (rc != 0) return false;
        _counters.Add(counter);
        return true;
    }

    public bool Collect()
    {
        return PdhCollectQueryData(_query) == 0;
    }

    /// <summary>
    /// Values aligned with the add order; NaN where PDH reports no valid data
    /// (stale instance, first sample, counter unavailable). Never skips slots,
    /// so the caller can keep instance names and values in the same order.
    /// </summary>
    public double[] ReadAligned()
    {
        var values = new double[_counters.Count];
        for (int i = 0; i < _counters.Count; i++)
        {
            PDH_FMT_COUNTERVALUE_DOUBLE v;
            uint rc = PdhGetFormattedCounterValue(_counters[i], PDH_FMT_DOUBLE, IntPtr.Zero, out v);
            bool ok = rc == 0 && (v.CStatus == 0 || v.CStatus == 1) && !double.IsNaN(v.doubleValue);
            values[i] = ok ? v.doubleValue : double.NaN;
        }
        return values;
    }

    public int CounterCount { get { return _counters.Count; } }

    public void Dispose()
    {
        if (_query != IntPtr.Zero)
        {
            PdhCloseQuery(_query);
            _query = IntPtr.Zero;
            _counters.Clear();
        }
    }
}
'@

$SAMPLE_MS = 2000
$GPU_SYNC_MS = 15000      # pick up engines of newly started processes without re-adding everything
$MAX_SLOTS = 1200         # past this, rebuild the query from scratch to drop dead instances

$gpuQuery = New-Object PdhQuery
$gpuNames = New-Object System.Collections.ArrayList
# Parallel to $gpuNames: the physical engine each instance belongs to. Windows
# reports utilization per PROCESS per engine, so a GPU-wide number has to be
# summed per engine and then compared across engines.
$gpuGroups = New-Object System.Collections.ArrayList
# Available (not merely free) memory: os.freemem on Windows excludes standby
# lists and overstates usage, so the same PDH query supplies the real number.
$memQuery = New-Object PdhQuery
if (-not $memQuery.AddCounter('\Memory\Available MBytes')) { $memQuery = $null }

# "pid_1234_luid_0x00000000_0x00014797_phys_0_eng_3_engtype_VideoDecode"
# -> "luid_0x00000000_0x00014797_phys_0_eng_3|VideoDecode": the same engine seen
# from several processes collapses into one bucket.
function Get-GpuGroupKey($instanceName) {
  $rest = $instanceName -replace '^pid_\d+_', ''
  return ($rest -replace '_engtype_', '|')
}

function Format-Num($value) {
  if ($null -eq $value -or [double]::IsNaN([double]$value)) { return 'null' }
  return ([double]$value).ToString('0.###', $inv)
}

function Sync-GpuCounters {
  $names = [PdhQuery]::EnumInstances('GPU Engine')
  $known = @{}
  foreach ($n in $gpuNames) { if ($null -ne $n) { $known[$n] = $true } }
  foreach ($n in $names) {
    if ($known.ContainsKey($n)) { continue }
    if ($gpuQuery.AddCounter("\GPU Engine($n)\Utilization Percentage")) {
      [void]$gpuNames.Add($n)
      [void]$gpuGroups.Add((Get-GpuGroupKey $n))
    }
  }
  # Stale instances are left in place (their readings turn NaN); a full rebuild
  # eventually reclaims them, which is cheaper than tracking removals.
  if ($gpuNames.Count -gt $MAX_SLOTS) {
    $gpuQuery.Dispose()
    $script:gpuQuery = New-Object PdhQuery
    $script:gpuNames = New-Object System.Collections.ArrayList
    $script:gpuGroups = New-Object System.Collections.ArrayList
    foreach ($n in $names) {
      if ($gpuQuery.AddCounter("\GPU Engine($n)\Utilization Percentage")) {
        [void]$gpuNames.Add($n)
        [void]$gpuGroups.Add((Get-GpuGroupKey $n))
      }
    }
    $null = $gpuQuery.Collect()
  }
}

function Read-Gpu {
  $null = $gpuQuery.Collect()
  $values = $gpuQuery.ReadAligned()
  $byEngine = @{}
  $sum = 0.0
  $maxInstance = 0.0
  $used = 0
  for ($i = 0; $i -lt $values.Length; $i++) {
    $v = $values[$i]
    if ([double]::IsNaN($v) -or $v -lt 0) { continue }
    $used++
    $sum += $v
    if ($v -gt $maxInstance) { $maxInstance = $v }
    $key = $gpuGroups[$i]
    if ($null -eq $key) { continue }
    if ($byEngine.ContainsKey($key)) { $byEngine[$key] += $v } else { $byEngine[$key] = $v }
  }
  if ($used -eq 0) { return [pscustomobject]@{ usage = $null; sum = $null; max = $null; n = 0; engines = 0 } }
  $busiest = 0.0
  foreach ($value in $byEngine.Values) { if ($value -gt $busiest) { $busiest = $value } }
  return [pscustomobject]@{
    usage   = [Math]::Min($busiest, 100.0)
    sum     = [Math]::Min($sum, 100.0)
    max     = $maxInstance
    n       = $used
    engines = $byEngine.Count
  }
}

Sync-GpuCounters
$null = $gpuQuery.Collect()

$lastGpuSync = [Environment]::TickCount
$lastError = ''

while ($true) {
  $gpu = $null
  $memFreeMB = $null
  try {
    $now = [Environment]::TickCount
    if (($now - $lastGpuSync) -ge $GPU_SYNC_MS) {
      Sync-GpuCounters
      $lastGpuSync = $now
    }
    $gpu = Read-Gpu
    if ($memQuery) {
      $null = $memQuery.Collect()
      $memValues = $memQuery.ReadAligned()
      if ($memValues.Length -gt 0 -and -not [double]::IsNaN($memValues[0]) -and $memValues[0] -ge 0) {
        $memFreeMB = $memValues[0]
      }
    }
  }
  catch {
    $lastError = $_.Exception.Message
  }
  $ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $line = '{"ts":' + $ts +
    ',"gpu":' + (Format-Num $(if ($gpu) { $gpu.usage } else { $null })) +
    ',"gpuSum":' + (Format-Num $(if ($gpu) { $gpu.sum } else { $null })) +
    ',"gpuMax":' + (Format-Num $(if ($gpu) { $gpu.max } else { $null })) +
    ',"gpuEngines":' + $(if ($gpu) { $gpu.engines } else { 0 }) +
    ',"gpuN":' + $(if ($gpu) { $gpu.n } else { 0 }) +
    ',"memFreeMB":' + (Format-Num $memFreeMB) +
    ',"err":"' + ($lastError -replace '\\', '\\\\' -replace '"', '\"') + '"' +
    '}'
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $SAMPLE_MS
}
