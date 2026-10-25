'use strict';

window.onHomeyReady = function onHomeyReady(Homey) {
  const element = (id) => document.getElementById(id);
  const settings = Homey.getSettings();
  const stove = settings.stove?.id;
  const half = settings.half_full_kg ?? 15;
  const full = settings.full_kg ?? 30;
  const t = (key, tokens) => Homey.__(`widget.${key}`, tokens);
  const supportedLanguages = ['en', 'nl', 'de', 'fr', 'it', 'sv', 'no', 'es', 'da', 'ru', 'pl', 'ko', 'ar'];
  const language = supportedLanguages.includes(t('language')) ? t('language') : 'en';
  document.documentElement.lang = language;
  document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
  const formatter = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  const format = (value) => (typeof value === 'number' && Number.isFinite(value) ? formatter.format(value) : '—');
  let state = null;
  let busy = false;
  let dirty = false;
  let editorOpen = false;
  let reading = false;
  let revision = 0;
  let timer;
  let stopped = false;
  let connectionFailed = false;
  let lastHeight;

  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  element('minus').setAttribute('aria-label', t('lower_target'));
  element('plus').setAttribute('aria-label', t('raise_target'));
  element('target').setAttribute('aria-label', `${t('set_target')} °C`);
  element('edit-target').setAttribute('aria-label', t('edit_target'));
  element('temperatures').setAttribute('aria-label', t('set_target'));
  element('pellet-section').setAttribute('aria-label', t('remaining'));
  element('pellet-meter').setAttribute('aria-label', t('remaining'));
  element('half-value').textContent = `${format(half)} ${t('kg')}`;
  element('full-value').textContent = `${format(full)} ${t('kg')}`;
  element('half').title = `${t('reset_to')} ${format(half)} ${t('kg')}`;
  element('full').title = `${t('reset_to')} ${format(full)} ${t('kg')}`;

  function message(text, error = false) {
    element('message').textContent = text;
    element('message').hidden = !text;
    element('message').classList.toggle('error', error);
  }

  function closeEditor(restoreFocus = true) {
    editorOpen = false;
    dirty = false;
    element('target-editor').hidden = true;
    element('widget-content').inert = false;
    if (restoreFocus && !element('edit-target').disabled) element('edit-target').focus();
  }

  function setFlameState() {
    element('widget').dataset.burning = String(!stopped && !document.hidden && state?.available === true
      && state.on === true && state.heating === true && state.error !== true);
  }

  function modeLabel() {
    const mode = state.mode?.trim();
    const keys = {
      heating: 'heating', run: 'heating', running: 'heating', start: 'starting', startup: 'starting',
      ignite: 'igniting', ignition: 'igniting', standby: 'standby', idle: 'standby',
      shutdown: 'shutting_down', cooling: 'cooling', off: 'off', stop: 'off',
    };
    if (mode) return Object.prototype.hasOwnProperty.call(keys, mode.toLowerCase()) ? t(keys[mode.toLowerCase()]) : mode;
    if (state.on === false) return t('off');
    return t(state.heating === true ? 'heating' : state.heating === false ? 'standby' : 'unknown');
  }

  function render() {
    const available = state?.available === true;
    const editable = available && state.canTarget && !state.weeklyProgram && !busy;
    element('widget').setAttribute('aria-busy', String(busy || reading));
    element('name').textContent = state?.name || settings.stove?.name || t('title');
    element('name').title = element('name').textContent;
    element('temperature').textContent = format(state?.temperature);
    element('target-value').textContent = format(state?.target);
    element('power').disabled = busy || !available || !state.canPower || typeof state.on !== 'boolean';
    element('power').setAttribute('aria-pressed', String(state?.on === true));
    element('power').setAttribute('aria-label', t(state?.on ? 'turn_off' : 'turn_on'));
    element('power-label').textContent = state?.on === true ? t('on') : state?.on === false ? t('off') : '—';

    let status = connectionFailed ? t('offline') : t('loading');
    const cleaningDue = available && typeof state.cleaningHours === 'number' && state.cleaningHours <= 0;
    if (state) {
      const cleaning = typeof state.cleaningHours === 'number'
        ? cleaningDue ? t('cleaning_required') : t('cleaning_in', { hours: format(state.cleaningHours) })
        : t('cleaning_unknown');
      status = available ? t('status_with_cleaning', { status: modeLabel(), cleaning }) : t('offline');
    }
    element('status').textContent = status;
    element('status-dot').classList.toggle('active', available && state.heating === true && !state.error);
    element('status-dot').classList.toggle('error', state?.error === true);
    element('status-dot').classList.toggle('cleaning-due', cleaningDue && !state.error);
    setFlameState();

    if (!available || state.weeklyProgram) closeEditor(false);
    element('edit-target').disabled = !editable;
    element('edit-mark').textContent = state?.weeklyProgram ? '—' : '✎';
    element('edit-target').title = state?.weeklyProgram ? t('weekly_program') : t('edit_target');
    const target = element('target');
    target.disabled = !editable || !editorOpen;
    target.min = state?.targetMin ?? 5;
    target.max = state?.targetMax ?? 35;
    target.step = state?.targetStep ?? 1;
    if (!dirty) target.value = state?.target ?? '';
    element('minus').disabled = !editable || !editorOpen;
    element('plus').disabled = !editable || !editorOpen;
    element('save').disabled = !editable || !editorOpen || !dirty || !target.checkValidity() || target.value === '';
    element('cancel').disabled = busy;
    element('target-dialog').setAttribute('aria-busy', String(busy));
    if (editorOpen && busy) element('target-dialog').focus();
    element('weekly').hidden = !state?.weeklyProgram;

    element('pellets').textContent = format(state?.pellets);
    const capacity = state?.pelletCapacity;
    const knownPellets = typeof state?.pellets === 'number' && typeof capacity === 'number' && capacity > 0;
    element('pellet-fill').style.width = knownPellets ? `${Math.min(100, Math.max(0, state.pellets / capacity * 100))}%` : '0%';
    const meter = element('pellet-meter');
    if (knownPellets) {
      meter.setAttribute('aria-valuemax', capacity);
      meter.setAttribute('aria-valuenow', Math.min(capacity, Math.max(0, state.pellets)));
      meter.setAttribute('aria-valuetext', `${format(state.pellets)} ${t('kg')}`);
    } else {
      meter.removeAttribute('aria-valuenow');
      meter.removeAttribute('aria-valuetext');
    }
    element('half').disabled = busy || !available || !state.canReset;
    element('full').disabled = busy || !available || !state.canReset;

    element('fault').hidden = state?.error !== true;
    element('fault-title').textContent = `${available ? t('stove_error') : t('last_error')}${state?.errorCode ? ` · ${state.errorCode}` : ''}`;
    element('fault-message').textContent = state?.errorMessage || t('unknown_error');
  }

  function schedule() {
    clearTimeout(timer);
    if (!stopped && !document.hidden) timer = setTimeout(refresh, 10000);
  }

  async function refresh() {
    clearTimeout(timer);
    if (stopped || document.hidden || typeof stove !== 'string' || !stove) return;
    if (busy || reading) { schedule(); return; }
    reading = true;
    const requestRevision = revision;
    try {
      const result = await Homey.api('GET', `/state?stove=${encodeURIComponent(stove)}`);
      if (!stopped && requestRevision === revision) {
        state = result;
        connectionFailed = false;
        render();
        message(state.available ? '' : t('offline'), !state.available);
      }
    } catch (error) {
      if (!stopped && requestRevision === revision) {
        state = null;
        connectionFailed = true;
        render();
        message(error.message || t('load_failed'), true);
      }
    } finally {
      reading = false;
      if (!stopped) { render(); schedule(); }
    }
  }

  async function control(action, value) {
    if (busy || !state?.available) return;
    revision += 1;
    const requestRevision = revision;
    busy = true;
    let targetCompleted = false;
    clearTimeout(timer);
    render();
    message(t('saving'));
    try {
      const result = await Homey.api('POST', '/control', { stove, action, value });
      if (stopped || requestRevision !== revision) return;
      state = result;
      connectionFailed = false;
      if (action === 'target') { closeEditor(false); targetCompleted = true; }
      message(state.available ? '' : t('offline'), !state.available);
    } catch (error) {
      if (stopped || requestRevision !== revision) return;
      // A failed response can follow an accepted command. Read state again before enabling controls.
      state = null;
      connectionFailed = true;
      message(error.message || t('command_failed'), true);
    } finally {
      busy = false;
      if (!stopped) {
        render();
        if (targetCompleted && !element('edit-target').disabled) element('edit-target').focus();
        schedule();
      }
    }
  }

  element('power').addEventListener('click', () => { if (state) control('power', !state.on); });
  element('edit-target').addEventListener('click', () => {
    if (element('edit-target').disabled) return;
    editorOpen = true;
    dirty = false;
    element('target-editor').hidden = false;
    element('widget-content').inert = true;
    render();
    element('target').focus();
    element('target').select();
  });
  element('cancel').addEventListener('click', () => { if (!busy) { closeEditor(); render(); } });
  element('target').addEventListener('input', () => { dirty = true; render(); });
  element('minus').addEventListener('click', () => { element('target').stepDown(); dirty = true; render(); });
  element('plus').addEventListener('click', () => { element('target').stepUp(); dirty = true; render(); });
  element('save').addEventListener('click', () => { if (!element('save').disabled) control('target', element('target').valueAsNumber); });
  element('half').addEventListener('click', () => control('pellets', half));
  element('full').addEventListener('click', () => control('pellets', full));
  document.addEventListener('keydown', (event) => {
    if (!editorOpen) return;
    if (event.key === 'Escape' && !busy) { closeEditor(); render(); return; }
    if (event.key === 'Enter' && document.activeElement === element('target')) {
      event.preventDefault();
      if (!element('save').disabled) control('target', element('target').valueAsNumber);
    }
    if (event.key === 'Tab') {
      const controls = ['minus', 'target', 'plus', 'cancel', 'save'].map(element).filter((node) => !node.disabled);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); element('target-dialog').focus(); return; }
      if (first && event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (last && !event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    setFlameState();
    if (!document.hidden) refresh();
  });
  const resize = new ResizeObserver(() => {
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    if (!stopped && height !== lastHeight) {
      lastHeight = height;
      Homey.setHeight(height).catch(console.error);
    }
  });
  window.addEventListener('pagehide', () => {
    stopped = true;
    revision += 1;
    state = null;
    closeEditor(false);
    setFlameState();
    clearTimeout(timer);
    resize.disconnect();
  });
  window.addEventListener('pageshow', () => {
    if (stopped) { stopped = false; render(); resize.observe(element('widget')); refresh(); }
  });
  render();
  Homey.ready();
  resize.observe(element('widget'));
  if (typeof stove === 'string' && stove) refresh();
  else { element('status').textContent = t('select_stove'); message(t('select_stove')); }
};
