/**
 * Minimal browser half of dsh-llm-antigravity-acp:
 * 1. Compact weekly-first quota pill beside the composer model seat (strictly hidden unless
 *    an Antigravity model is active; context occupancy uses DSH's native ContextMeter).
 * 2. Concise Settings section for tier and connection controls.
 */
window.__ModuleLoader__.load({
  id: 'dsh-llm-antigravity-acp',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const PROVIDER = 'antigravity'
    const PACKAGE = 'dsh-llm-antigravity-acp'
    const SERVICE = 'antigravityAcp'

    const isZh = () => typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '')
    const t = (en, cn) => (isZh() ? cn : en)

    function codec(symbol, parse) {
      return { mode: 'strict', typeSymbol: `${PACKAGE}#${symbol}`, create: () => ({ parse }) }
    }
    const anyObject = (value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid antigravity payload')
      return value
    }
    const optionalObject = (value) => (value === undefined || value === null ? undefined : anyObject(value))
    const DESCRIPTORS = [
      { id: `${PACKAGE}#${SERVICE}/status`, service: SERVICE, namespace: SERVICE, method: 'status', invocation: { kind: 'direct' }, parameters: [], result: codec('Status', anyObject) },
      { id: `${PACKAGE}#${SERVICE}/quota`, service: SERVICE, namespace: SERVICE, method: 'quota', invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true, codec: codec('QuotaRequest', optionalObject) }], result: codec('Quota', anyObject) },
      { id: `${PACKAGE}#${SERVICE}/warmup`, service: SERVICE, namespace: SERVICE, method: 'warmup', invocation: { kind: 'direct' }, parameters: [], result: codec('Status', anyObject) },
      { id: `${PACKAGE}#${SERVICE}/configure`, service: SERVICE, namespace: SERVICE, method: 'configure', invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: false, codec: codec('ConfigureRequest', anyObject) }], result: codec('Status', anyObject) },
    ]

    function unwrap(result) {
      if (result && typeof result === 'object' && 'ok' in result) {
        if (result.ok) return result.value
        throw new Error((result.error && result.error.message) || 'unknown error')
      }
      return result
    }

    function makeClient(scope) {
      const call = async (method, ...args) => {
        const deadline = Date.now() + 20_000
        for (;;) {
          const service = scope.get(`remote.${SERVICE}`)
          if (service && typeof service[method] === 'function') return unwrap(await service[method](...args))
          if (Date.now() >= deadline) throw new Error(t('Antigravity service is not ready', 'Antigravity 服务尚未就绪'))
          await new Promise((resolve) => setTimeout(resolve, 400))
        }
      }
      return {
        status: () => call('status'),
        /**
         * Status that never waits for the remote service. Background reads
         * (row warm-up, live settings) use this so a page that has not mounted
         * the service yet costs nothing instead of parking a retry loop.
         * @returns the status, or undefined when the service is not mounted.
         */
        statusNow: () => {
          const service = scope.get(`remote.${SERVICE}`)
          if (!service || typeof service.status !== 'function') return Promise.resolve(undefined)
          return Promise.resolve(service.status()).then(unwrap)
        },
        quota: (force) => call('quota', force ? { force: true } : undefined),
        warmup: () => call('warmup'),
        configure: (patch) => call('configure', patch),
      }
    }

    const pct = (fraction) => `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`
    const tokens = (n) => (n >= 1_000_000 ? `${(n / 1_048_576).toFixed(n % 1_048_576 === 0 ? 0 : 2)}M` : `${Math.round(n / 1000)}K`)
    const geminiGroup = (groups) => (groups || []).find((g) => /gemini/i.test(g.name)) || (groups || [])[0]
    const quotaGroupFor = (groups, model) => {
      const list = groups || []
      const thirdParty = /claude|gpt|oss/i.test(model || '')
      return list.find((g) => thirdParty ? /claude|gpt|oss/i.test(g.name) : /gemini/i.test(g.name)) || list[0]
    }
    const familyName = (group) => {
      const name = ((group && group.name) || '').replace(/\s*models?\s*$/i, '').trim()
      if (/claude.*gpt|gpt.*claude/i.test(name)) return t('Claude and GPT', 'Claude 与 GPT')
      return name || t('Antigravity', 'Antigravity')
    }
    const isWeeklyBucket = (b) => !!b && (b.window === 'weekly' || /week/i.test(b.id || '') || /week/i.test(b.name || ''))
    const isShortBucket = (b) => !!b && (b.window === '5h' || /\b5\s*h\b|five[-_\s]*hour/i.test(b.id || '') || /\b5\s*h\b|5\s*小时|five[-_\s]*hour/i.test(b.name || ''))
    const bucketRank = (b) => (isWeeklyBucket(b) ? 0 : isShortBucket(b) ? 1 : 2)
    const sortBuckets = (buckets) => [...(buckets || [])].sort((a, b) => bucketRank(a) - bucketRank(b))
    const windowLabel = (bucket) => (isShortBucket(bucket) ? t('5h', '5 小时') : isWeeklyBucket(bucket) ? t('Weekly', '每周') : bucket.name)
    const resetLabel = (iso) => {
      const ms = Date.parse(iso) - Date.now()
      if (!Number.isFinite(ms)) return ''
      if (ms <= 0) return t('now', '即将重置')
      const totalMinutes = Math.max(1, Math.round(ms / 60_000))
      const hours = Math.floor(totalMinutes / 60)
      const minutes = totalMinutes % 60
      if (hours >= 24) return t(`${Math.floor(hours / 24)}d ${hours % 24}h`, `${Math.floor(hours / 24)}天${hours % 24}小时`)
      return t(`${hours}h ${minutes}m`, `${hours}小时${minutes}分`)
    }
    const resetPhrase = (iso) => {
      const r = resetLabel(iso)
      if (!r) return ''
      if (r === 'now' || r === '即将重置') return t('Resets now', '即将重置')
      return t(`Resets in ${r}`, `${r}后重置`)
    }
    const pillTitle = (primary, short, error, family) => {
      const label = family || t('Antigravity', 'Antigravity')
      if (!primary) {
        return error ? t(`${label} quota: ${error}`, `${label} 套餐额度：${error}`) : t(`${label} quota`, `${label} 套餐额度`)
      }
      const head = isWeeklyBucket(primary)
        ? t(`${label} weekly quota ${pct(primary.remainingFraction)}`, `${label} 每周额度 ${pct(primary.remainingFraction)}`)
        : t(`${label} ${windowLabel(primary)} quota ${pct(primary.remainingFraction)}`, `${label} ${windowLabel(primary)}额度 ${pct(primary.remainingFraction)}`)
      const r = resetLabel(primary.resetTime)
      const resetPart = !r
        ? ''
        : r === 'now' || r === '即将重置'
          ? t(' (resets now)', '（即将重置）')
          : t(` (resets in ${r})`, `（${r}后重置）`)
      const shortPart = short && short !== primary
        ? t(` · 5h ${pct(short.remainingFraction)}`, ` · 5 小时 ${pct(short.remainingFraction)}`)
        : ''
      return `${head}${resetPart}${shortPart}`
    }

    const toneColor = (fraction) => (fraction < 0.15 ? '#d9534f' : fraction < 0.35 ? '#e0a800' : '#2e9e6a')
    const bar = (fraction, width = 28, height = 4) => h('span', {
      'aria-hidden': 'true',
      style: {
        display: width === '100%' ? 'block' : 'inline-block',
        width,
        height,
        borderRadius: 999,
        background: 'color-mix(in srgb, currentColor 16%, transparent)',
        overflow: 'hidden',
        verticalAlign: 'middle',
        flexShrink: 0,
      },
    }, h('span', {
      style: {
        display: 'block',
        height: '100%',
        width: pct(fraction),
        borderRadius: 999,
        background: toneColor(fraction),
      },
    }))

    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    }

    // One scoped stylesheet for every control this package draws: the shipped
    // model-menu cell geometry, so a provider row inside the composer menu and
    // a row inside the Settings section read as the same component. Colors are
    // --dsw-alias-* tokens so every theme keeps working.
    const ROW_CSS = [
      '.dsh-agy-list{display:flex;flex-direction:column}',
      '.dsh-agy-row{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:0 8px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left}',
      'button.dsh-agy-row{cursor:pointer;outline:none}',
      'button.dsh-agy-row:disabled{color:var(--dsw-alias-label-dimmed);cursor:default;opacity:.5}',
      'button.dsh-agy-row:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}',
      '@media(hover:hover){button.dsh-agy-row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}',
      '.dsh-agy-label{flex:0 0 auto;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
      'button.dsh-agy-row:disabled .dsh-agy-label{color:var(--dsw-alias-label-dimmed)}',
      '.dsh-agy-value{flex:1 1 auto;min-width:0;text-align:right;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
      '.dsh-agy-row[data-interactive="true"] .dsh-agy-value{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-agy-chevron{flex:0 0 auto;width:12px;height:12px;color:var(--dsw-alias-menu-icon);transition:transform 120ms ease}',
      '.dsh-agy-options{display:flex;flex-direction:column}',
      '.dsh-agy-option{padding-left:20px}',
      '.dsh-agy-check{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;color:var(--dsw-alias-label-primary)}',
      '.dsh-agy-stack{display:flex;flex-wrap:wrap;gap:10px 14px;justify-content:flex-end}',
    ].join('\n')
    const STYLE_ID = 'antigravity-acp-rows-style'
    function ensureStyles() {
      const doc = typeof document === 'undefined' ? undefined : document
      if (!doc || !doc.createElement || !doc.head || !doc.head.appendChild) return
      if (doc.getElementById && doc.getElementById(STYLE_ID)) return
      const style = doc.createElement('style')
      style.id = STYLE_ID
      style.textContent = ROW_CSS
      doc.head.appendChild(style)
    }

    const chevron = (open) => h('svg', {
      className: 'dsh-agy-chevron',
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      style: open ? { transform: 'rotate(90deg)' } : undefined,
    }, h('path', {
      d: 'M9 6l6 6-6 6', stroke: 'currentColor', 'stroke-width': 2,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }))

    const checkMark = () => h('span', { className: 'dsh-agy-check', 'aria-hidden': 'true' },
      h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none' },
        h('path', {
          d: 'M5 13l4 4L19 7', stroke: 'currentColor', 'stroke-width': 2,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        })))

    /**
     * One setting as a row: label on the left, the current value and a chevron
     * on the right, and the available values as a check-marked list that opens
     * inline. The composer menu needs `menuitem`/`menuitemradio` roles so DSH's
     * arrow-key routing reaches the rows; a Settings section uses plain buttons.
     */
    function ChoiceRow(props) {
      const [open, setOpen] = React.useState(false)
      const current = props.options.find((option) => option.value === props.value)
      const menu = props.menu === true
      return h('div', { className: 'dsh-agy-list' },
        h('button', {
          type: 'button',
          ...(menu ? { role: 'menuitem' } : {}),
          'aria-expanded': open,
          'aria-label': `${props.label} ${current ? current.label : ''}`.trim(),
          disabled: props.disabled,
          'data-interactive': 'true',
          className: 'dsh-agy-row',
          onClick: () => { if (!props.disabled) setOpen(!open) },
        },
          h('span', { className: 'dsh-agy-label' }, props.label),
          h('span', { className: 'dsh-agy-value' }, current ? current.label : '—'),
          chevron(open)),
        open ? h('div', { className: 'dsh-agy-options' },
          ...props.options.map((option) => h('button', {
            key: String(option.value),
            type: 'button',
            ...(menu ? { role: 'menuitemradio' } : {}),
            'aria-checked': option.value === props.value,
            disabled: props.disabled,
            className: 'dsh-agy-row dsh-agy-option',
            onClick: () => {
              if (props.disabled) return
              setOpen(false)
              props.onChange(option.value)
            },
          },
            h('span', { className: 'dsh-agy-label' }, option.label),
            h('span', { className: 'dsh-agy-value' }, option.value === props.value ? checkMark() : null)))) : null)
    }

    /**
     * A read-only row: same geometry as {@link ChoiceRow} without hover, focus,
     * chevron, or expansion.
     */
    function InfoRow(props) {
      return h('div', { className: 'dsh-agy-row' },
        h('span', { className: 'dsh-agy-label' }, props.label),
        h('span', { className: 'dsh-agy-value' }, props.children ?? props.value))
    }

    function QuotaPill(props) {
      const state = useStore(props.store)
      const selection = state && state.current
      const active = !!selection && selection.provider === PROVIDER
      const rootRef = React.useRef(null)
      const [quota, setQuota] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)

      const refresh = React.useCallback(async (force) => {
        setBusy(true)
        try {
          const q = await props.client.quota(force)
          setQuota(q)
          setError(q.status === 'error' ? q.error || null : null)
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }, [props.client])

      React.useEffect(() => {
        if (!active) { setOpen(false); return undefined }
        void refresh(false)
        const timer = setInterval(() => { void refresh(false) }, 180_000)
        return () => clearInterval(timer)
      }, [active, refresh])

      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (e) => {
          const root = rootRef.current
          if (!root) return
          const inside = typeof root.contains === 'function' ? root.contains(e.target) : root === e.target
          if (!inside) setOpen(false)
        }
        const onKeyDown = (e) => { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      if (!active) return null
      const group = quota ? quotaGroupFor(quota.groups, selection.model) : undefined
      const family = familyName(group)
      const rawBuckets = group ? group.buckets : []
      const buckets = sortBuckets(rawBuckets)
      const primary = rawBuckets.find(isWeeklyBucket) || rawBuckets[0]
      const short = buckets.find(isShortBucket)
      const secondary = primary ? buckets.filter((b) => b !== primary) : []
      const pillPrefix = !primary || isWeeklyBucket(primary) ? t('Wk', '周') : windowLabel(primary)
      const pillValue = primary ? pct(primary.remainingFraction) : error ? '!' : '…'
      const tooltip = pillTitle(primary, short, error, family)

      return h('span', { ref: rootRef, className: 'antigravity-quota-pill', style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        h('button', {
          type: 'button',
          title: tooltip,
          'aria-label': tooltip,
          'aria-expanded': open,
          onClick: () => { setOpen(!open); if (!open) void refresh(false) },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '2px 7px',
            border: 'none',
            borderRadius: 999,
            background: open ? 'color-mix(in srgb, currentColor 8%, transparent)' : 'transparent',
            color: 'inherit',
            font: 'inherit',
            fontSize: 12,
            lineHeight: '18px',
            whiteSpace: 'nowrap',
            opacity: open ? 0.92 : 0.8,
            cursor: 'pointer',
          },
        },
          primary ? bar(primary.remainingFraction, 24, 4) : null,
          h('span', { style: { display: 'inline-flex', alignItems: 'baseline', gap: 3, fontVariantNumeric: 'tabular-nums' } },
            h('span', { style: { opacity: 0.72, fontSize: 11 } }, pillPrefix),
            ' ',
            h('span', { style: { fontWeight: 500, color: !primary && error ? '#d9534f' : 'inherit' } }, pillValue))),
        open ? h('div', {
          role: 'dialog',
          'aria-label': t('Quota', '额度'),
          style: {
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            right: 0,
            zIndex: 50,
            boxSizing: 'border-box',
            width: 'max-content',
            minWidth: 248,
            maxWidth: 'min(320px, calc(100vw - 24px))',
            padding: '12px 14px',
            borderRadius: 12,
            background: 'var(--dsw-alias-surface-overlay, var(--dsw-alias-bg-overlay, var(--dsw-specific-menu, Canvas)))',
            backdropFilter: 'var(--dsw-menu-backdrop-filter, blur(20px) saturate(140%))',
            WebkitBackdropFilter: 'var(--dsw-menu-backdrop-filter, blur(20px) saturate(140%))',
            color: 'var(--dsw-alias-label-primary, CanvasText)',
            boxShadow: 'var(--dsw-elevation-prominent, 0 8px 28px rgba(0,0,0,.18))',
            border: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: 'nowrap',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: primary ? 9 : 6 } },
            h('span', { style: { fontWeight: 600, fontSize: 12 } }, t('Quota', '额度')),
            h('button', {
              type: 'button',
              disabled: busy,
              title: t('Refresh', '刷新'),
              onClick: () => void refresh(true),
              style: {
                border: 'none',
                borderRadius: 5,
                background: 'color-mix(in srgb, currentColor 6%, transparent)',
                color: 'inherit',
                opacity: busy ? 0.45 : 0.78,
                font: 'inherit',
                fontSize: 11,
                lineHeight: '18px',
                padding: '1px 7px',
                cursor: busy ? 'default' : 'pointer',
              },
            }, busy ? '…' : t('Refresh', '刷新'))),
          !primary ? h('div', { style: { opacity: 0.68, whiteSpace: 'normal' } }, error || t('Loading…', '读取中…')) : null,
          primary ? h('div', {
            key: primary.id || 'primary',
            'data-bucket-window': primary.window || primary.id,
            'data-bucket-role': 'primary',
            style: {
              padding: '9px 10px',
              borderRadius: 8,
              background: 'color-mix(in srgb, currentColor 5%, transparent)',
              border: '1px solid color-mix(in srgb, currentColor 8%, transparent)',
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 } },
              h('span', { style: { fontWeight: 500, opacity: 0.86 } }, isWeeklyBucket(primary) ? t('Weekly quota', '每周额度') : windowLabel(primary)),
              h('span', { style: { opacity: 0.58, fontSize: 11, fontVariantNumeric: 'tabular-nums' } }, resetPhrase(primary.resetTime))),
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, margin: '3px 0 7px' } },
              h('span', {
                style: {
                  fontSize: 20,
                  fontWeight: 650,
                  lineHeight: 1.15,
                  fontVariantNumeric: 'tabular-nums',
                  letterSpacing: '-0.02em',
                  color: primary.remainingFraction < 0.15 ? '#d9534f' : 'inherit',
                },
              }, pct(primary.remainingFraction)),
              h('span', { style: { fontSize: 11, opacity: 0.55 } }, t('remaining', '剩余'))),
            bar(primary.remainingFraction, '100%', 6)) : null,
          secondary.length > 0 ? h('div', {
            style: {
              marginTop: 9,
              paddingTop: 8,
              borderTop: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            },
          }, ...secondary.map((b) => h('div', {
            key: b.id,
            'data-bucket-window': b.window || b.id,
            'data-bucket-role': 'secondary',
            style: {
              display: 'grid',
              gridTemplateColumns: 'minmax(44px, auto) 44px 36px minmax(0, 1fr)',
              alignItems: 'center',
              gap: 8,
              lineHeight: '18px',
            },
          },
            h('span', { style: { opacity: 0.76 } }, windowLabel(b)),
            bar(b.remainingFraction, 44, 4),
            h('span', { style: { fontVariantNumeric: 'tabular-nums', fontWeight: 500, textAlign: 'right' } }, pct(b.remainingFraction)),
            h('span', { style: { opacity: 0.55, textAlign: 'right', fontSize: 11, fontVariantNumeric: 'tabular-nums' } }, resetLabel(b.resetTime))))) : null,
          primary && error ? h('div', { role: 'status', style: { marginTop: 8, color: '#d9534f', fontSize: 11, whiteSpace: 'normal', opacity: 0.9 } }, error) : null)
          : null)
    }

    const EFFORT_OPTIONS = [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ]

    /** Context-window choices, shared by the Settings row and the menu row. */
    const windowOptions = () => [
      { value: 0, label: t('Auto (1M)', '自动 (1M)') },
      { value: 900000, label: '900K' },
      { value: 512000, label: '512K' },
      { value: 256000, label: '256K' },
    ]

    /** Long-decode choices: Antigravity's control over how far one reply may run. */
    const decodeOptions = () => [
      { value: 0, label: t('Off', '关闭') },
      { value: 3, label: t('3x', '3 段') },
      { value: 8, label: t('8x', '8 段') },
    ]

    // Live settings last reported by the Host, mirrored into localStorage: the
    // menu rows mount before any round-trip finishes, and a slow or failed
    // status call must not leave the rows blank.
    const SETTINGS_STORAGE_KEY = 'dsh.antigravity.settings.v1'
    const readStoredSettings = () => {
      try {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(SETTINGS_STORAGE_KEY)
        const parsed = raw === null ? null : JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
      } catch { return null }
    }
    const stored = readStoredSettings()
    let cachedSettings = stored === null ? null : {
      configuredContextWindow: Number(stored.configuredContextWindow) || 0,
      longDecodeContinuations: Number.isFinite(stored.longDecodeContinuations) ? stored.longDecodeContinuations : 3,
    }
    /** Remember the settings-bearing half of a status snapshot. */
    const rememberSettings = (status) => {
      if (!status || typeof status !== 'object') return
      cachedSettings = {
        ...cachedSettings,
        ...(Number.isFinite(status.configuredContextWindow) ? { configuredContextWindow: status.configuredContextWindow } : {}),
        ...(Number.isFinite(status.longDecodeContinuations) ? { longDecodeContinuations: status.longDecodeContinuations } : {}),
      }
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(cachedSettings))
      } catch { /* storage may be unavailable; the in-memory copy still serves */ }
    }

    function SettingsCard(props) {
      const [status, setStatus] = React.useState(null)
      const [quota, setQuota] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const load = React.useCallback(async (warm) => {
        setBusy(true)
        try {
          const s = warm ? await props.client.warmup() : await props.client.status()
          setStatus(s)
          rememberSettings(s)
          setQuota(await props.client.quota(warm))
          setError(s.error || null)
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }, [props.client])
      const applyPatch = React.useCallback(async (patch) => {
        setBusy(true)
        try {
          const s = await props.client.configure(patch)
          setStatus(s)
          rememberSettings(s)
          setError(s.error || null)
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }, [props.client])
      React.useEffect(() => { void load(false) }, [load])
      const stateText = status ? { idle: t('Idle', '待命'), starting: t('Starting', '启动中'), ready: t('Connected', '已连接'), error: t('Error', '异常') }[status.state] : '…'
      const group = quota ? geminiGroup(quota.groups) : undefined
      const sortedGroupBuckets = group ? sortBuckets(group.buckets) : []
      return h('section', { className: 'antigravity-settings-card', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          h('h3', { style: { margin: 0, fontSize: 15 } }, 'Antigravity'),
          h('button', { type: 'button', disabled: busy, onClick: () => void load(true), style: { font: 'inherit', fontSize: 12, padding: '3px 10px', borderRadius: 6, border: '1px solid color-mix(in srgb, currentColor 22%, transparent)', background: 'transparent', color: 'inherit', cursor: 'pointer' } }, busy ? '…' : t('Refresh', '刷新'))),
        status ? h('div', { className: 'dsh-agy-list' },
          h(InfoRow, { label: t('Status', '状态'), value: `${stateText} · agy ${status.version || '—'} · ${tokens(status.contextWindow)}${status.unlock && status.unlock.status === 'unlocked' ? t(' unlocked', ' 已解锁') : ''}` }),
          h(ChoiceRow, {
            label: t('Window', '上下文窗口'),
            options: windowOptions(),
            value: status.configuredContextWindow ?? 0,
            disabled: busy,
            onChange: (v) => void applyPatch({ contextWindow: v }),
          }),
          h(ChoiceRow, {
            label: t('Default effort', '默认思考'),
            options: EFFORT_OPTIONS,
            value: status.defaultEffort || 'high',
            disabled: busy,
            onChange: (v) => void applyPatch({ defaultEffort: v }),
          }),
          h(ChoiceRow, {
            label: t('Long decode', '超长续写'),
            options: decodeOptions(),
            value: status.longDecodeContinuations ?? 3,
            disabled: busy,
            onChange: (v) => void applyPatch({ longDecodeContinuations: v }),
          }),
          group ? h(InfoRow, { label: t('Gemini quota', 'Gemini 额度') },
            h('span', { className: 'dsh-agy-stack' },
              ...sortedGroupBuckets.map((b) => h('span', { key: b.id, 'data-bucket-window': b.window || b.id, style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
                h('span', { style: { opacity: isWeeklyBucket(b) ? 0.9 : 0.72, fontWeight: isWeeklyBucket(b) ? 600 : 400 } }, windowLabel(b)),
                bar(b.remainingFraction, 34),
                h('span', { style: { fontVariantNumeric: 'tabular-nums', fontWeight: isWeeklyBucket(b) ? 600 : 400 } }, pct(b.remainingFraction)),
                h('span', { style: { opacity: 0.55 } }, resetLabel(b.resetTime)))))) : null)
          : null,
        error ? h('div', { role: 'alert', style: { color: '#d9534f', fontSize: 12 } }, error) : null)
    }

    /**
     * Provider parameter rows in the composer's model menu: the same two live
     * settings as the Settings section, at the moment a model is being chosen.
     * Everything is applied through `configure`, so the next request reads the
     * new value and the menu stays open.
     */
    function ModelParameterRows(props) {
      const state = useStore(props.directory.store)
      const selection = state && state.current
      const active = !!selection && selection.provider === PROVIDER
      const [status, setStatus] = React.useState(cachedSettings)
      const [busy, setBusy] = React.useState(false)
      React.useEffect(() => {
        if (!active) return undefined
        let live = true
        props.client.statusNow().then((s) => { if (live && s) { rememberSettings(s); setStatus({ ...s }) } }).catch(() => { /* keep the last observation */ })
        return () => { live = false }
      }, [active, props.client])
      if (!active) return null
      const fail = (message) => { if (typeof props.reportFailure === 'function') props.reportFailure(message) }
      const apply = (patch) => {
        if (props.locked || busy) return
        setBusy(true)
        props.client.configure(patch).then((s) => {
          rememberSettings(s)
          setStatus({ ...cachedSettings, ...s })
        }, (error) => {
          fail(error instanceof Error ? error.message : String(error))
        }).finally(() => setBusy(false))
      }
      return h('div', { className: 'dsh-agy-list' },
        h(ChoiceRow, {
          menu: true,
          label: t('Context', '上下文'),
          options: windowOptions(),
          value: status ? status.configuredContextWindow ?? 0 : 0,
          disabled: props.locked || busy,
          onChange: (v) => apply({ contextWindow: v }),
        }),
        h(ChoiceRow, {
          menu: true,
          label: t('Long decode', '超长续写'),
          options: decodeOptions(),
          value: status ? status.longDecodeContinuations ?? 3 : 3,
          disabled: props.locked || busy,
          onChange: (v) => apply({ longDecodeContinuations: v }),
        }))
    }

    return {
      name: PACKAGE,
      inject: ['slots', 'remote'],
      apply(ctx) {
        try {
          const mounted = ctx.remote.$mount({ package: PACKAGE, descriptors: DESCRIPTORS })
          ctx.effect(() => mounted, 'antigravity-acp: mount remote')
        } catch (error) {
          console.error('[dsh-llm-antigravity-acp] remote mount failed:', error)
        }
        const client = makeClient(ctx)
        ctx.effect(() => {
          ensureStyles()
          // Warm the live settings once per page load so the menu rows paint
          // from the cached copy instead of waiting on a round-trip.
          let live = true
          client.statusNow().then((s) => { if (live) rememberSettings(s) }).catch(() => { /* the rows fall back to the last stored copy */ })
          return () => { live = false }
        }, 'antigravity-acp: row styles and live settings')
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'antigravity-acp',
          order: 41,
          label: () => 'Antigravity',
          inject: () => ({ client }),
        }, SettingsCard)), 'antigravity-acp: settings section')
        ctx.inject(['slots', 'modelDirectories'], (scope) => {
          scope.effect(() => scope.slots.inject('conversation.input.right', () => scope.slots.register({
            name: 'conversation.input.right',
            id: 'antigravity-acp-quota',
            order: 1001,
            inject: (sessionId) => ({ store: scope.modelDirectories.directoryFor(sessionId).store, client }),
          }, QuotaPill)), 'antigravity-acp: quota pill')
          scope.effect(() => scope.slots.inject('conversation.input.model.parameters', () => scope.slots.register({
            name: 'conversation.input.model.parameters',
            id: 'antigravity-acp-parameters',
            order: 100,
            inject: (sessionId) => ({ directory: scope.modelDirectories.directoryFor(sessionId), client, sessionId }),
          }, ModelParameterRows)), 'antigravity-acp: model parameter rows')
        })
      },
    }
  },
})
