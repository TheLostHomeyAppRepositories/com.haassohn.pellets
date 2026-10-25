const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const api = require('../widgets/stove/api.js');

test('generated app exports a Homey App class and registers the stove selector without changing Flow IDs', async () => {
  class App { log() {} }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../.homeybuild/app.js'), 'utf8'), {
    module, exports: module.exports, require: (id) => { assert.equal(id, 'homey'); return { App }; },
  });
  const instance = new module.exports();
  assert.ok(instance instanceof App);
  let selector;
  const flowIds = [];
  instance.homey = {
    flow: { getActionCard: (id) => { flowIds.push(id); return { registerRunListener() {} }; } },
    dashboards: { getWidget: (id) => {
      assert.equal(id, 'stove');
      return { registerSettingAutocompleteListener: (setting, listener) => { assert.equal(setting, 'stove'); selector = listener; } };
    } },
    drivers: { getDriver: () => ({ ready: async () => {}, getDevices: () => [
      { getName: () => 'Living room', getData: () => ({ id: 'living' }) },
      { getName: () => 'Kitchen', getData: () => ({ id: 'kitchen' }) },
    ] }) },
  };
  await instance.onInit();
  assert.deepEqual(flowIds, ['set_pellets', 'set_weekprogram', 'set_eco_mode']);
  assert.deepEqual(JSON.parse(JSON.stringify(await selector('LIVING'))), [{ name: 'Living room', id: 'living' }]);
});

test('packaged widget preserves browser scripts, API exports and Compose definitions', () => {
  const source = fs.readFileSync(require.resolve('../widgets/stove/public/widget.js'), 'utf8');
  const packaged = fs.readFileSync(require.resolve('../.homeybuild/widgets/stove/public/widget.js'), 'utf8');
  assert.equal(packaged, source);
  const manifest = JSON.parse(fs.readFileSync(require.resolve('../app.json'), 'utf8'));
  const compose = JSON.parse(fs.readFileSync(require.resolve('../widgets/stove/widget.compose.json'), 'utf8'));
  assert.deepEqual(manifest.widgets.stove, { ...compose, id: 'stove' });
  assert.equal(typeof require('../.homeybuild/widgets/stove/api.js').getState, 'function');
  assert.equal(typeof require('../.homeybuild/widgets/stove/api.js').setControl, 'function');
});

function fixture() {
  const values = {
    onoff: false, measure_temperature: 21.4, target_temperature: 23,
    measure_stove_pellets: 12.5, stove_mode: 'shutdown', stove_status: false,
    stove_weekprogram_active: false, stove_error_state: false, stove_error_code: '', measure_stove_cleaning_in: 12,
  };
  const calls = [];
  const device = {
    ready: async () => {}, getData: () => ({ id: 'paired-stove' }), getName: () => 'Living room',
    getAvailable: () => true, hasCapability: (id) => Object.hasOwn(values, id),
    getCapabilityValue: (id) => values[id], getWidgetErrorMessage: () => null, getWidgetPelletCapacity: () => 30,
    getCapabilityOptions: (id) => (id === 'target_temperature' ? { min: 5, max: 35, step: 1 } : { max: 30 }),
    triggerCapabilityListener: async (id, value) => { calls.push([id, value]); values[id] = value; },
  };
  const driver = { ready: async () => {}, getDevices: () => [device] };
  const homey = { drivers: { getDriver: (id) => { assert.equal(id, 'pellet_stove'); return driver; } }, __: (key) => key, error: () => {} };
  const read = (id = 'paired-stove') => api.getState({ homey, query: { stove: id } });
  const write = (action, value) => api.setControl({ homey, body: { stove: 'paired-stove', action, value } });
  return { values, calls, device, homey, read, write };
}

test('reads reported values, including zero, without exposing device settings', async () => {
  const f = fixture();
  f.device.getSettings = () => ({ pin: 'secret' });
  f.values.measure_temperature = 0;
  f.values.measure_stove_pellets = 0;
  const state = await f.read();
  assert.equal(state.temperature, 0);
  assert.equal(state.pellets, 0);
  assert.equal(state.target, 23);
  assert.equal(state.cleaningHours, 12);
  assert.equal(state.mode, 'shutdown');
  assert.equal(JSON.stringify(state).includes('secret'), false);
  assert.deepEqual(f.calls, []);
});

test('rejects missing, malformed, and removed stove selections', async () => {
  const f = fixture();
  for (const id of [undefined, null, {}, '', ' ', 'another-stove']) {
    await assert.rejects(api.getState({ homey: f.homey, query: { stove: id } }));
  }
  await assert.rejects(api.setControl({ homey: f.homey, body: null }));
  assert.deepEqual(f.calls, []);
});

test('unavailable or missing capabilities disable controls and cannot be written', async () => {
  const f = fixture();
  f.device.getAvailable = () => false;
  const state = await f.read();
  assert.equal(state.temperature, null);
  assert.equal(state.target, null);
  assert.equal(state.cleaningHours, null);
  assert.equal(state.canPower, false);
  await assert.rejects(f.write('power', true), /widget.offline/);
  f.device.getAvailable = () => true;
  delete f.values.target_temperature;
  assert.equal((await f.read()).canTarget, false);
  await assert.rejects(f.write('target', 22), /widget.unsupported/);
});

test('routes explicit on/off requests through the existing listener', async () => {
  const f = fixture();
  assert.equal((await f.write('power', true)).on, true);
  assert.equal((await f.write('power', false)).on, false);
  for (const value of ['true', 1, null]) await assert.rejects(f.write('power', value), /widget.invalid_value/);
  assert.deepEqual(f.calls, [['onoff', true], ['onoff', false]]);
});

test('enforces temperature range, step, finite numbers and weekly-program lock', async () => {
  const f = fixture();
  for (const value of [4, 36, 22.5, NaN, Infinity, '22', null]) await assert.rejects(f.write('target', value), /widget.invalid_temperature/);
  assert.equal((await f.write('target', 24)).target, 24);
  f.values.stove_weekprogram_active = true;
  assert.equal((await f.read()).weeklyProgram, true);
  await assert.rejects(f.write('target', 25), /widget.weekly_program/);
  assert.deepEqual(f.calls, [['target_temperature', 24]]);
});

test('uses actual device temperature options, including fractional steps', async () => {
  const f = fixture();
  f.device.getCapabilityOptions = (id) => (id === 'target_temperature' ? { min: 10, max: 28, step: .5 } : { max: 30 });
  await f.write('target', 22.5);
  await assert.rejects(f.write('target', 22.25));
  await assert.rejects(f.write('target', 29));
});

test('resets pellet estimate to absolute custom amounts and rejects silent capacity clamping', async () => {
  const f = fixture();
  assert.equal((await f.write('pellets', 15)).pellets, 15);
  assert.equal((await f.write('pellets', 30)).pellets, 30);
  for (const value of [0, -1, 15.5, 1000, '15', null]) await assert.rejects(f.write('pellets', value), /widget.invalid_pellets/);
  await assert.rejects(f.write('pellets', 40), /widget.pellet_capacity/);
  f.device.getWidgetPelletCapacity = () => 50;
  await f.write('pellets', 40);
  assert.deepEqual(f.calls, [['measure_stove_pellets', 15], ['measure_stove_pellets', 30], ['measure_stove_pellets', 40]]);
});

test('pellet resets use authoritative capacity even when capability options are stale', async () => {
  const f = fixture();
  f.device.getWidgetPelletCapacity = () => 20;
  assert.equal((await f.read()).pelletCapacity, 20);
  await assert.rejects(f.write('pellets', 30), /widget.pellet_capacity/);
  assert.deepEqual(f.calls, []);
  f.device.getCapabilityOptions = () => ({ max: 10 });
  await f.write('pellets', 20);
  assert.deepEqual(f.calls, [['measure_stove_pellets', 20]]);
});

test('preserves reported stove errors and handles unknown numeric readings', async () => {
  const f = fixture();
  f.values.stove_error_state = true;
  f.values.stove_error_code = 'F026';
  f.device.getWidgetErrorMessage = () => 'F026: Pellet hopper is empty';
  f.values.measure_temperature = NaN;
  const state = await f.read();
  assert.equal(state.error, true);
  assert.equal(state.errorCode, 'F026');
  assert.equal(state.errorMessage, 'F026: Pellet hopper is empty');
  assert.equal(state.temperature, null);
});

test('serializes widget commands for one stove and releases the lock after failure', async () => {
  const f = fixture();
  let reject;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  f.device.triggerCapabilityListener = () => { entered(); return new Promise((resolve, fail) => { reject = fail; }); };
  const pending = f.write('power', true);
  await started;
  await assert.rejects(f.write('pellets', 15), /widget.busy/);
  reject(new Error('Transport timeout'));
  await assert.rejects(pending, /Transport timeout/);
  f.device.triggerCapabilityListener = async () => {};
  await f.write('power', false);
});

test('cleaning countdown preserves zero/overdue values and treats missing readings as unknown', async () => {
  const f = fixture();
  for (const value of [0, -1, 12.5]) {
    f.values.measure_stove_cleaning_in = value;
    assert.equal((await f.read()).cleaningHours, value);
  }
  for (const value of [null, NaN, Infinity, '12']) {
    f.values.measure_stove_cleaning_in = value;
    assert.equal((await f.read()).cleaningHours, null);
  }
  delete f.values.measure_stove_cleaning_in;
  assert.equal((await f.read()).cleaningHours, null);
});

test('all Homey languages have complete widget strings, tokens and settings translations', () => {
  const languages = ['en', 'nl', 'de', 'fr', 'it', 'sv', 'no', 'es', 'da', 'ru', 'pl', 'ko', 'ar'];
  const english = require('../locales/en.json').widget;
  const compose = require('../widgets/stove/widget.compose.json');
  for (const language of languages) {
    const strings = require(`../locales/${language}.json`).widget;
    assert.deepEqual(Object.keys(strings).sort(), Object.keys(english).sort(), language);
    assert.equal(strings.language, language);
    for (const [key, value] of Object.entries(strings)) {
      assert.equal(typeof value, 'string');
      assert.ok(value.trim(), `${language}.${key}`);
      const tokens = text => (text.match(/__[a-z_]+__/g) || []).sort();
      assert.deepEqual(tokens(value), tokens(english[key]), `${language}.${key} tokens`);
    }
    for (const translation of [compose.name, ...compose.settings.flatMap(setting => [setting.title, setting.hint])]) {
      assert.ok(translation[language], `Compose ${language}`);
    }
  }
});

function browserFixture(language = 'en') {
  const nodes = new Map();
  let document;
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      textContent: '', style: {}, dataset: {}, disabled: false, hidden: false,
      listeners: {}, attributes: {}, classList: { toggle() {} },
      addEventListener(event, fn) { this.listeners[event] = fn; },
      setAttribute(key, value) { this.attributes[key] = String(value); },
      removeAttribute(key) { delete this.attributes[key]; },
      checkValidity() { return this.value !== '' && this.valueAsNumber >= Number(this.min) && this.valueAsNumber <= Number(this.max); },
      focus() { document.activeElement = this; }, select() {},
      stepUp() { this.value = this.valueAsNumber + Number(this.step); },
      stepDown() { this.value = this.valueAsNumber - Number(this.step); },
      getBoundingClientRect() { return { height: 480 }; },
    });
    if (!Object.hasOwn(nodes.get(id), 'value')) {
      let value = '';
      Object.defineProperty(nodes.get(id), 'value', { get: () => value, set: next => { value = String(next); } });
      Object.defineProperty(nodes.get(id), 'valueAsNumber', { get: () => value === '' ? NaN : Number(value) });
    }
    return nodes.get(id);
  }
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  const documentEvents = {};
  const windowEvents = {};
  document = { hidden: false, documentElement: { lang: 'en' }, getElementById: node, querySelectorAll: () => [], addEventListener: (event, listener) => { documentEvents[event] = listener; }, body: node('body') };
  const window = { addEventListener: (event, listener) => { windowEvents[event] = listener; } };
  const strings = require(`../locales/${language}.json`).widget;
  const Homey = {
    getSettings: () => ({ stove: { id: 'paired-stove', name: 'Living room' }, half_full_kg: 12, full_kg: 24 }),
    __: (key, tokens = {}) => {
      let text = strings[key.split('.').pop()] || key;
      for (const [name, value] of Object.entries(tokens)) text = text.replaceAll(`__${name}__`, value);
      return text;
    }, ready() {}, setHeight: async () => {},
    api: (method, path, body) => new Promise((resolve, reject) => { requests.push({ method, path, body, resolve, reject }); }),
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../widgets/stove/public/widget.js'), 'utf8'), {
    window, document, Intl, console, ResizeObserver: class { observe() {} disconnect() {} },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
  });
  window.onHomeyReady(Homey);
  const flush = () => new Promise(setImmediate);
  const state = { available: true, name: 'Living room', on: false, temperature: 21.4, target: 23, cleaningHours: 12, targetMin: 5, targetMax: 35, targetStep: 1, canPower: true, canTarget: true, canReset: true, pellets: 12.5, pelletCapacity: 30, heating: false, mode: 'standby', error: false };
  return { node, requests, timers, flush, state, document, documentEvents, windowEvents };
}

test('browser sends configured pellet amounts and prevents duplicate taps', async () => {
  const f = browserFixture();
  f.requests[0].resolve(f.state);
  await f.flush();
  f.node('half').listeners.click();
  f.node('half').listeners.click();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1].body)), { stove: 'paired-stove', action: 'pellets', value: 12 });
  assert.equal(f.node('power').disabled, true);
  f.requests[1].resolve({ ...f.state, pellets: 12 });
  await f.flush();
  assert.equal(f.node('pellets').textContent, '12');
  assert.equal(f.node('power').disabled, false);
  assert.equal(f.node('message').hidden, true);
});

test('browser ignores a stale read that resolves after a command', async () => {
  const f = browserFixture();
  f.requests[0].resolve(f.state);
  await f.flush();
  [...f.timers.values()][0]();
  f.node('power').listeners.click();
  assert.equal(f.requests.length, 3);
  f.requests[2].resolve({ ...f.state, on: true });
  await f.flush();
  f.requests[1].resolve(f.state);
  await f.flush();
  assert.equal(f.node('power').attributes['aria-pressed'], 'true');
});

test('browser clears temperatures and disables controls after a read or command failure', async () => {
  const f = browserFixture();
  f.requests[0].resolve(f.state);
  await f.flush();
  f.node('power').listeners.click();
  f.requests[1].reject(new Error('Timeout'));
  await f.flush();
  assert.equal(f.node('temperature').textContent, '—');
  assert.equal(f.node('power').disabled, true);
  assert.equal(f.node('status').textContent, require('../locales/en.json').widget.offline);
  assert.equal(f.node('message').textContent, 'Timeout');
});

test('browser preserves a draft while editable, then shows reported target when weekly scheduling locks it', async () => {
  const f = browserFixture();
  f.requests[0].resolve(f.state);
  await f.flush();
  f.node('edit-target').listeners.click();
  f.node('target').value = '25';
  f.node('target').listeners.input();
  assert.equal(f.node('target-value').textContent, '23');
  [...f.timers.values()][0]();
  f.requests[1].resolve({ ...f.state, target: 24 });
  await f.flush();
  assert.equal(f.node('target').value, '25');
  assert.equal(f.node('target-value').textContent, '24');
  [...f.timers.values()][0]();
  f.requests[2].resolve({ ...f.state, target: 24, weeklyProgram: true });
  await f.flush();
  assert.equal(f.node('target').value, '24');
  assert.equal(f.node('target-value').textContent, '24');
  assert.equal(f.node('target-editor').hidden, true);
  assert.equal(f.node('target').disabled, true);
  assert.equal(f.node('save').disabled, true);
  assert.equal(f.node('weekly').hidden, false);
});

test('browser combines operating state and regular cleaning without stale or invented countdowns', async () => {
  const f = browserFixture();
  f.requests[0].resolve({ ...f.state, on: true, heating: true, mode: 'heating' });
  await f.flush();
  assert.equal(f.node('status').textContent, 'Heating, Cleaning in 12h');
  const update = async next => {
    [...f.timers.values()][0]();
    f.requests.at(-1).resolve({ ...f.state, ...next });
    await f.flush();
  };
  await update({ mode: 'off' });
  assert.equal(f.node('status').textContent, 'Off, Cleaning in 12h');
  await update({ mode: 'off', cleaningHours: 0 });
  assert.equal(f.node('status').textContent, 'Off, Cleaning required');
  await update({ mode: 'off', cleaningHours: -1 });
  assert.equal(f.node('status').textContent, 'Off, Cleaning required');
  await update({ mode: 'off', cleaningHours: null });
  assert.equal(f.node('status').textContent, 'Off, Cleaning status unknown');
  await update({ available: false, cleaningHours: null });
  assert.equal(f.node('status').textContent, require('../locales/en.json').widget.offline);
});

test('browser target dialog cancels without a write and applies through the existing target contract', async () => {
  const f = browserFixture();
  f.requests[0].resolve(f.state);
  await f.flush();
  assert.equal(f.node('target-editor').hidden, true);
  f.node('edit-target').listeners.click();
  assert.equal(f.node('target-editor').hidden, false);
  assert.equal(f.node('widget-content').inert, true);
  f.node('target').value = '25';
  f.node('target').listeners.input();
  f.node('cancel').listeners.click();
  assert.equal(f.node('target-editor').hidden, true);
  assert.equal(f.node('target-value').textContent, '23');
  assert.equal(f.requests.length, 1);
  f.node('edit-target').listeners.click();
  f.node('target').value = '24';
  f.node('target').listeners.input();
  f.node('save').listeners.click();
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1].body)), { stove: 'paired-stove', action: 'target', value: 24 });
  f.requests[1].resolve({ ...f.state, target: 24 });
  await f.flush();
  assert.equal(f.node('target-value').textContent, '24');
  assert.equal(f.node('target-editor').hidden, true);
  assert.equal(f.node('message').hidden, true);
});

test('browser flames require reported heating, availability, on state and no error', async () => {
  const f = browserFixture();
  f.requests[0].resolve({ ...f.state, on: true, heating: true, mode: 'heating' });
  await f.flush();
  assert.equal(f.node('widget').dataset.burning, 'true');
  f.document.hidden = true;
  f.documentEvents.visibilitychange();
  assert.equal(f.node('widget').dataset.burning, 'false');
  assert.equal(f.timers.size, 0);
  f.document.hidden = false;
  f.documentEvents.visibilitychange();
  f.requests.at(-1).resolve({ ...f.state, on: true, heating: true, error: true });
  await f.flush();
  assert.equal(f.node('widget').dataset.burning, 'false');
});

test('browser keeps modal focus when all controls are disabled by a pending target command', async () => {
  const f = browserFixture();
  f.requests[0].resolve(f.state);
  await f.flush();
  f.node('edit-target').listeners.click();
  f.node('target').value = '24';
  f.node('target').listeners.input();
  f.node('save').listeners.click();
  assert.equal(f.document.activeElement, f.node('target-dialog'));
  for (const shiftKey of [false, true]) {
    let prevented = false;
    f.documentEvents.keydown({ key: 'Tab', shiftKey, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(f.document.activeElement, f.node('target-dialog'));
    assert.equal(f.node('target-editor').hidden, false);
  }
  f.requests[1].resolve({ ...f.state, target: 24 });
  await f.flush();
  assert.equal(f.node('target-editor').hidden, true);
  assert.equal(f.document.activeElement, f.node('edit-target'));
});

test('browser ignores a read from before pagehide when the page is restored', async () => {
  const f = browserFixture();
  f.requests[0].resolve(f.state);
  await f.flush();
  [...f.timers.values()][0]();
  f.windowEvents.pagehide();
  f.windowEvents.pageshow();
  f.requests[1].resolve({ ...f.state, target: 99 });
  await f.flush();
  assert.equal(f.node('target-value').textContent, '—');
  [...f.timers.values()][0]();
  f.requests[2].resolve(f.state);
  await f.flush();
  assert.equal(f.node('target-value').textContent, '23');
});

test('browser uses all widget locales and mirrors Arabic with localized numbers', async () => {
  for (const language of ['en', 'nl', 'de', 'fr', 'it', 'sv', 'no', 'es', 'da', 'ru', 'pl', 'ko', 'ar']) {
    const f = browserFixture(language);
    f.requests[0].resolve(f.state);
    await f.flush();
    assert.equal(f.document.documentElement.lang, language);
    assert.equal(f.document.documentElement.dir, language === 'ar' ? 'rtl' : 'ltr');
    assert.equal(f.node('temperature').textContent, new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(21.4));
    assert.equal(f.node('status').textContent.includes('__'), false);
    assert.equal(f.node('status').textContent.includes('widget.'), false);
  }
});

test('browser clears stale command errors after a successful refresh', async () => {
  const f = browserFixture();
  f.requests[0].resolve(f.state);
  await f.flush();
  f.node('power').listeners.click();
  f.requests[1].reject(new Error('Timeout'));
  await f.flush();
  assert.equal(f.node('message').textContent, 'Timeout');
  [...f.timers.values()][0]();
  f.requests[2].resolve({ ...f.state, on: true });
  await f.flush();
  assert.equal(f.node('message').textContent, '');
  assert.equal(f.node('message').hidden, true);
  assert.equal(f.node('temperature').textContent, '21.4');
  assert.equal(f.node('power').disabled, false);
});
