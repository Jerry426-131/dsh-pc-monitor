/**
 * dsh-pc-monitor — browser half.
 *
 * Mounts a three-dial card just above the sidebar's Settings row: CPU, memory
 * and GPU utilization. Plain DOM, no React, and the card is attached to
 * <body> with `position: fixed` — it is measured against the Settings row's
 * rect instead of being inserted into React's sidebar tree. Living inside that
 * tree made React reconciliation swap the node under the pointer on every
 * re-render, which showed up as a cursor flickering between arrow and hand.
 *
 * Colors come from the DSH theme tokens (`--dsw-alias-*`, `--dsw-specific-*`)
 * with dark fallbacks, so the card follows the active theme; the dial colors
 * themselves stay on the load ramp, because there the color IS the reading.
 *
 * Reads GET /api/dsh-pc-monitor/snapshot (relative URL: the GUI may be served
 * from a sub-path). GPU comes back null when the host sampler is not
 * available — that dial shows a dash instead of inventing a number.
 *
 * @module dsh-pc-monitor/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-pc-monitor',
  factory: () => {
    const STYLE_ID = 'dsh-pc-monitor-style'
    const CARD_ATTR = 'data-dsh-pcmon-card'
    const SNAPSHOT_URL = 'api/dsh-pc-monitor/snapshot'
    const POLL_MS = 2000
    /**
     * Load ramp in sRGB, stops taken from the LolColors palette
     * (#47B8E0 / #5BD6C0 / #FFC952 / #FF7473): blue idle, mint, amber, then
     * red-coral near the top. Interpolating in sRGB keeps the middle bands from
     * flashing magenta the way a raw hue wrap would.
     */
    const COLOR_STOPS = [
      [0, '#47b8e0'],
      [35, '#5bd6c0'],
      [65, '#ffc952'],
      [88, '#ff7473'],
      [100, '#e8455f'],
    ]
    /** Card stays out of a collapsed sidebar instead of squeezing the dials. */
    const MIN_CARD_WIDTH = 168
    /** A footer row is short; a flex spacer is not, and must not become the anchor. */
    const MAX_ROW_HEIGHT = 160
    const CARD_GAP = 8
    const ANCHOR_MS = 1000

    const DIALS = ['cpu', 'mem', 'gpu']
    /**
     * Labels follow the DSH UI language instead of a hardcoded one. CPU and GPU
     * stay as-is everywhere; the memory dial is the only translated word, and
     * English uses RAM because "memory" alone reads like storage or VRAM.
     */
    const STRINGS = {
      zh: { mem: '内存', cpuHint: 'CPU 占用', memHint: '内存占用', gpuHint: 'GPU 占用', card: '电脑性能实时监测', title: '电脑性能实时监测 · 每 2 秒刷新' },
      en: { mem: 'RAM', cpuHint: 'CPU usage', memHint: 'Memory usage', gpuHint: 'GPU usage', card: 'Live system performance', title: 'Live system performance · refreshes every 2 s' },
    }

    const STYLE = `
.dsh-pcmon {
  position: fixed;
  z-index: 60;
  box-sizing: border-box;
  display: flex;
  flex-direction: row;
  align-items: flex-end;
  justify-content: space-between;
  gap: 6px;
  padding: 9px 10px 7px;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(96, 156, 255, 0.16));
  background:
    radial-gradient(120% 140% at 12% 0%,
      color-mix(in srgb, var(--dsw-alias-brand-primary, #47b8e0) 16%, transparent),
      transparent 58%),
    var(--dsw-alias-bg-layer-1, rgba(9, 16, 30, 0.94));
  backdrop-filter: blur(10px);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.34);
  font-family: ui-monospace, "SFMono-Regular", "Cascadia Mono", Consolas, monospace;
  color: var(--dsw-alias-label-secondary, #cfe4ff);
  --dsh-pcmon-idle-arc: color-mix(in srgb, var(--dsw-alias-label-secondary, #a0c4f0) 34%, transparent);
  --dsh-pcmon-idle-text: color-mix(in srgb, var(--dsw-alias-label-secondary, #a0c4f0) 60%, transparent);
  user-select: none;
  -webkit-user-select: none;
  cursor: default;
  pointer-events: auto;
}
/* The card lives on <body> now, but the sidebar around it still belongs to the
   Settings button; pin the cursor so no inherited pointer can blink through. */
.dsh-pcmon,
.dsh-pcmon * {
  cursor: default !important;
}
.dsh-pcmon[data-hidden="1"] {
  display: none;
}
.dsh-pcmon-gauge {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  min-width: 46px;
}
.dsh-pcmon-dial {
  position: relative;
  width: 46px;
  height: 46px;
}
.dsh-pcmon-dial > svg {
  position: absolute;
  inset: 0;
  width: 46px;
  height: 46px;
  transform: rotate(-90deg);
  overflow: visible;
}
.dsh-pcmon-track {
  fill: none;
  stroke: color-mix(in srgb, var(--dsw-alias-label-secondary, #a0c4f0) 20%, transparent);
  stroke-width: 3.5;
}
.dsh-pcmon-arc {
  fill: none;
  stroke-width: 3.5;
  stroke-linecap: round;
  stroke-dasharray: 119.38;
  stroke-dashoffset: 119.38;
  transition: stroke-dashoffset 400ms cubic-bezier(0.22, 0.7, 0.2, 1), stroke 400ms linear, filter 400ms linear;
  filter: drop-shadow(0 0 1.4px currentColor) drop-shadow(0 0 4.2px currentColor);
}
.dsh-pcmon-value {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1;
  text-shadow: 0 0 4.2px currentColor;
  transition: color 400ms linear;
}
.dsh-pcmon-value[data-len="4"] {
  font-size: 9px;
  letter-spacing: -0.07em;
}
.dsh-pcmon-label {
  font-size: 9px;
  line-height: 1;
  letter-spacing: 0.06em;
  color: var(--dsw-alias-label-secondary, rgba(160, 196, 240, 0.72));
  opacity: 0.8;
  white-space: nowrap;
}
`

    function hexToRgb(hex) {
      return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16))
    }

    /** Colour for a 0..1 load ratio, interpolated across COLOR_STOPS. */
    function colorFor(ratio) {
      const load = Math.min(100, Math.max(0, ratio * 100))
      for (let index = 1; index < COLOR_STOPS.length; index++) {
        const [stopAt, stopHex] = COLOR_STOPS[index]
        const [prevAt, prevHex] = COLOR_STOPS[index - 1]
        if (load <= stopAt) {
          const span = stopAt - prevAt
          const progress = span === 0 ? 0 : (load - prevAt) / span
          const from = hexToRgb(prevHex)
          const to = hexToRgb(stopHex)
          const mix = from.map((value, channel) => Math.round(value + (to[channel] - value) * progress))
          return `rgb(${mix[0]} ${mix[1]} ${mix[2]})`
        }
      }
      return COLOR_STOPS[COLOR_STOPS.length - 1][1]
    }

    function arcLength() {
      return 119.38
    }

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = STYLE
      document.head.appendChild(style)
    }

    /**
     * The DSH client exposes its active locale on ctx.locale; page `lang` and
     * the browser list are only a fallback for hosts without that service.
     */
    function detectLang(ctx) {
      let active = ''
      try {
        active = ctx?.locale?.getLocale?.()?.active || ''
      } catch {
        active = ''
      }
      if (!active) active = document.documentElement.lang || navigator.language || ''
      return /^zh/i.test(active) ? 'zh' : 'en'
    }

    function createCard() {
      const card = document.createElement('div')
      card.className = 'dsh-pcmon'
      card.setAttribute(CARD_ATTR, '')
      card.setAttribute('role', 'group')

      const refs = {}
      const labels = {}
      const hints = {}
      for (const key of DIALS) {
        const gauge = document.createElement('div')
        gauge.className = 'dsh-pcmon-gauge'

        const dialBox = document.createElement('div')
        dialBox.className = 'dsh-pcmon-dial'
        dialBox.innerHTML =
          '<svg viewBox="0 0 46 46" aria-hidden="true">' +
          '<circle class="dsh-pcmon-track" cx="23" cy="23" r="19"></circle>' +
          '<circle class="dsh-pcmon-arc" cx="23" cy="23" r="19"></circle>' +
          '</svg>'
        const value = document.createElement('span')
        value.className = 'dsh-pcmon-value'
        value.textContent = '--'
        dialBox.appendChild(value)

        const label = document.createElement('span')
        label.className = 'dsh-pcmon-label'

        gauge.appendChild(dialBox)
        gauge.appendChild(label)
        card.appendChild(gauge)

        labels[key] = label
        hints[key] = gauge
        refs[key] = {
          arc: dialBox.querySelector('.dsh-pcmon-arc'),
          value,
        }
      }
      return { card, refs, labels, hints }
    }

    /** Applies localized text; runs again whenever the DSH locale changes. */
    function localize(card, labels, hints, lang) {
      const s = STRINGS[lang] || STRINGS.en
      labels.cpu.textContent = 'CPU'
      labels.mem.textContent = s.mem
      labels.gpu.textContent = 'GPU'
      hints.cpu.title = s.cpuHint
      hints.mem.title = s.memHint
      hints.gpu.title = s.gpuHint
      card.setAttribute('aria-label', s.card)
      card.title = s.title
    }

    /** Writes the dial text and keeps the length class in sync. */
    function setValueText(ref, text) {
      if (ref.value.textContent !== text) ref.value.textContent = text
      ref.value.dataset.len = String(text.length)
    }

    /** Paints one dial. ratio null = no data (dash, empty ring). */
    function paint(refs, key, ratio, text) {
      const ref = refs[key]
      if (!ref) return
      const full = arcLength()
      if (ratio === null || Number.isNaN(ratio)) {
        ref.arc.style.stroke = 'var(--dsh-pcmon-idle-arc, rgba(126, 178, 255, 0.28))'
        // drop-shadow() reads currentColor, so keep color in step with the arc.
        ref.arc.style.color = 'var(--dsh-pcmon-idle-text, rgba(126, 178, 255, 0.45))'
        ref.arc.style.strokeDashoffset = String(full)
        ref.value.style.color = 'var(--dsh-pcmon-idle-text, rgba(160, 196, 240, 0.55))'
        setValueText(ref, text)
        return
      }
      const clamped = Math.min(1, Math.max(0, ratio))
      const color = colorFor(clamped)
      ref.arc.style.stroke = color
      ref.arc.style.color = color
      ref.arc.style.strokeDashoffset = String(full * (1 - clamped))
      ref.value.style.color = color
      setValueText(ref, text)
    }

    function findHost() {
      const sidebar =
        document.querySelector('[data-pane="sidebar"]') ||
        document.querySelector('[class*="sidebarCol"]')
      if (!sidebar) return null
      const foot = sidebar.querySelector('[class*="footArea"]') || sidebar
      const settings = foot.querySelector('[class*="settingsArea"]')
      // Other footer plugins (e.g. dsh-usage) stack cards above Settings. Anchor
      // to the topmost visible footer row so this card never covers them, while
      // keeping the Settings row's own inset for left/width. Anything taller than
      // a row is layout scaffolding (a flex spacer), not a footer item.
      const rows = [...foot.children].filter((el) => {
        if (el.hasAttribute(CARD_ATTR)) return false
        const box = el.getBoundingClientRect()
        return box.height > 0 && box.height <= MAX_ROW_HEIGHT && box.width >= MIN_CARD_WIDTH
      })
      return { top: rows[0] || settings || foot, box: settings || foot }
    }

    /**
     * Keeps the fixed card glued above the sidebar's Settings row. The card is
     * never inserted into React's tree: React re-renders the footer on every
     * conversation update and replaces the row it owns, which used to swap the
     * element under the pointer and make the cursor blink. Re-measuring a rect
     * once a second is far cheaper than re-parenting on every mutation.
     */
    function anchor(card) {
      const host = findHost()
      if (!host) {
        card.dataset.hidden = '1'
        return
      }
      const rect = host.box.getBoundingClientRect()
      const top = host.top.getBoundingClientRect()
      if (rect.width < MIN_CARD_WIDTH || top.height === 0) {
        card.dataset.hidden = '1'
        return
      }
      delete card.dataset.hidden
      // Only touch the style when the geometry actually moved: a no-op write
      // still invalidates layout, and the card must stay still under the pointer.
      const left = `${Math.round(rect.left)}px`
      const width = `${Math.round(rect.width)}px`
      const bottom = `${Math.round(window.innerHeight - top.top + CARD_GAP)}px`
      if (card.style.left !== left) card.style.left = left
      if (card.style.width !== width) card.style.width = width
      if (card.style.bottom !== bottom) card.style.bottom = bottom
    }

    return {
      inject: [],
      apply(ctx) {
        const disposers = []
        const { card, refs, labels, hints } = createCard()
        let timer = null
        let anchorTimer = null
        let disposed = false

        const stopPolling = () => {
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
        }

        const poll = async () => {
          if (disposed) return
          if (document.visibilityState === 'hidden') {
            timer = setTimeout(poll, POLL_MS)
            return
          }
          try {
            const response = await fetch(`${SNAPSHOT_URL}?t=${Date.now()}`, {
              cache: 'no-store',
              credentials: 'same-origin',
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            paint(refs, 'cpu', typeof data.cpu === 'number' ? data.cpu / 100 : null, numText(data.cpu))
            paint(refs, 'mem', data.mem && typeof data.mem.pct === 'number' ? data.mem.pct / 100 : null, numText(data.mem?.pct))
            paint(refs, 'gpu', typeof data.gpu === 'number' ? data.gpu / 100 : null, numText(data.gpu))
          } catch {
            paint(refs, 'cpu', null, '--')
            paint(refs, 'mem', null, '--')
            paint(refs, 'gpu', null, '--')
          }
          if (!disposed) timer = setTimeout(poll, POLL_MS)
        }

        const numText = (value) =>
          typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}%` : '--'

        ensureStyle()
        // Localize first so the card never flashes a placeholder language, then
        // re-localize on every DSH locale switch (service is optional by design).
        localize(card, labels, hints, detectLang(ctx))
        try {
          const unsubscribe = ctx?.locale?.subscribe?.(() => localize(card, labels, hints, detectLang(ctx)))
          if (typeof unsubscribe === 'function') disposers.push(unsubscribe)
        } catch {
          // Older host without a locale face: the browser fallback still applies.
        }
        document.body.appendChild(card)
        anchor(card)
        const onResize = () => anchor(card)
        window.addEventListener('resize', onResize)
        disposers.push(() => window.removeEventListener('resize', onResize))
        anchorTimer = setInterval(() => {
          if (!disposed) anchor(card)
        }, ANCHOR_MS)
        disposers.push(() => {
          if (anchorTimer !== null) clearInterval(anchorTimer)
        })

        const onVisibility = () => {
          if (document.visibilityState === 'visible') {
            stopPolling()
            void poll()
          }
        }
        document.addEventListener('visibilitychange', onVisibility)
        disposers.push(() => document.removeEventListener('visibilitychange', onVisibility))

        void poll()

        const cleanup = () => {
          disposed = true
          stopPolling()
          if (anchorTimer !== null) clearInterval(anchorTimer)
          for (const dispose of disposers.splice(0)) {
            try {
              dispose()
            } catch {
              // ignore
            }
          }
          card.remove()
          document.getElementById(STYLE_ID)?.remove()
        }

        if (typeof ctx.effect === 'function') {
          ctx.effect(() => cleanup, 'dsh-pc-monitor:card')
        } else {
          // Older client hosts: fall back to the window lifecycle.
          window.addEventListener('pagehide', cleanup, { once: true })
        }
      },
    }
  },
})
