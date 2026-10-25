'use strict';

const busyDevices = new WeakSet();

function fail(homey, key) {
  throw new Error(homey.__(`widget.${key}`));
}

async function getStove(homey, id) {
  if (typeof id !== 'string' || !id.trim()) fail(homey, 'select_stove');
  const driver = homey.drivers.getDriver('pellet_stove');
  await driver.ready();
  const device = driver.getDevices().find((stove) => stove.getData().id === id);
  if (!device) fail(homey, 'stove_removed');
  await device.ready();
  return device;
}

function number(value, fallback = null) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function snapshot(device) {
  const read = (id) => (device.hasCapability(id) ? device.getCapabilityValue(id) : null);
  const available = device.getAvailable();
  const options = device.hasCapability('target_temperature') ? device.getCapabilityOptions('target_temperature') : {};
  const boolean = (value) => (typeof value === 'boolean' ? value : null);
  return {
    name: device.getName(),
    available,
    on: boolean(read('onoff')),
    temperature: available ? number(read('measure_temperature')) : null,
    target: available ? number(read('target_temperature')) : null,
    cleaningHours: available ? number(read('measure_stove_cleaning_in')) : null,
    targetMin: number(options?.min, 5),
    targetMax: number(options?.max, 35),
    targetStep: number(options?.step, 1),
    canPower: available && device.hasCapability('onoff'),
    canTarget: available && device.hasCapability('target_temperature'),
    canReset: available && device.hasCapability('measure_stove_pellets'),
    weeklyProgram: read('stove_weekprogram_active') === true,
    pellets: number(read('measure_stove_pellets')),
    pelletCapacity: device.getWidgetPelletCapacity(),
    mode: typeof read('stove_mode') === 'string' ? read('stove_mode') : null,
    heating: boolean(read('stove_status')),
    error: boolean(read('stove_error_state')),
    errorCode: typeof read('stove_error_code') === 'string' ? read('stove_error_code') : null,
    errorMessage: device.getWidgetErrorMessage(),
  };
}

module.exports = {
  async getState({ homey, query }) {
    return snapshot(await getStove(homey, query.stove));
  },

  async setControl({ homey, body }) {
    const device = await getStove(homey, body?.stove);
    if (!device.getAvailable()) fail(homey, 'offline');
    if (busyDevices.has(device)) fail(homey, 'busy');
    const state = snapshot(device);
    const { action, value } = body;
    let capability;
    if (action === 'power') {
      if (typeof value !== 'boolean') fail(homey, 'invalid_value');
      capability = 'onoff';
    } else if (action === 'target') {
      if (state.weeklyProgram) fail(homey, 'weekly_program');
      if (number(value) === null || value < state.targetMin || value > state.targetMax
        || state.targetStep <= 0 || Math.abs((value - state.targetMin) / state.targetStep - Math.round((value - state.targetMin) / state.targetStep)) > 0.000001) {
        fail(homey, 'invalid_temperature');
      }
      capability = 'target_temperature';
    } else if (action === 'pellets') {
      if (!Number.isInteger(value) || value < 1 || value > 999) fail(homey, 'invalid_pellets');
      if (value > state.pelletCapacity) fail(homey, 'pellet_capacity');
      capability = 'measure_stove_pellets';
    } else {
      fail(homey, 'invalid_value');
    }
    if (!device.hasCapability(capability)) fail(homey, 'unsupported');
    busyDevices.add(device);
    try {
      await device.triggerCapabilityListener(capability, value, {});
      return snapshot(device);
    } catch (error) {
      homey.error('Stove widget command failed', error);
      throw error;
    } finally {
      busyDevices.delete(device);
    }
  },
};
