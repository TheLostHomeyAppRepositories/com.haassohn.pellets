import Homey from 'homey';
import { HaasSohnApi, HaasSohnStatus } from '../../lib/haassohn-api.js';

type CapabilityType = 'boolean' | 'number' | 'string';
type PelletsAutoResetMode = 'none' | 'reset15' | 'reset30';

const OBJECT_AS_STRING_KEYS = new Set<string>([
  'meta.wlan_features',
]);

const DEFAULT_PELLETS_KG = 15;
const MIN_PELLETS_KG = 0;
const DEFAULT_MAX_PELLETS_KG = 30;

const STATE_TO_CAPABILITY: Record<string, string> = {
  prg: 'onoff',
  sp_temp: 'target_temperature',
  is_temp: 'measure_temperature',
  mode: 'stove_mode',
  zone: 'stove_zone',
  cleaning_in: 'measure_stove_cleaning_in',
  maintenance_in: 'measure_stove_maintenance_in',
  consumption: 'measure_stove_consumption',
  pellets: 'stove_pellets_actual',
  eco_mode: 'stove_eco_mode',
  wprg: 'stove_weekprogram_active',
  ht_char: 'stove_heating_curve',
  ignitions: 'stove_ignitions',
  on_time: 'stove_on_time',
  'meta.eco_editable': 'meta_eco_editable',
};

const ERROR_CODE_MAP: Record<number, string[]> = {
  1: [
    'errors.1.1',
    'errors.1.2',
    'errors.1.3',
  ],
  2: [
    'errors.2.1',
    'errors.2.2',
    'errors.2.3',
    'errors.2.4',
    'errors.2.5',
    'errors.2.6',
    'errors.2.7',
    'errors.2.8',
  ],
  3: [
    'errors.3.1',
    'errors.3.2',
    'errors.3.3',
  ],
  5: [
    'errors.5.1',
    'errors.5.2',
    'errors.5.3',
    'errors.5.4',
    'errors.5.5',
    'errors.5.6',
    'errors.5.7',
  ],
  6: [
    'errors.6.1',
    'errors.6.2',
    'errors.6.3',
    'errors.6.4',
  ],
  7: [
    'errors.7.1',
  ],
  8: [
    'errors.8.1',
  ],
  9: [
    'errors.9.1',
  ],
  11: [
    'errors.11.1',
  ],
  12: [
    'errors.12.1',
  ],
  13: [
    'errors.13.1',
  ],
  14: [
    'errors.14.1',
  ],
  15: [
    'errors.15.1',
    'errors.15.2',
  ],
  18: [
    'errors.18.1',
  ],
  21: [
    'errors.21.1',
    'errors.21.2',
    'errors.21.3',
    'errors.21.4',
    'errors.21.5',
    'errors.21.6',
    'errors.21.7',
  ],
  22: [
    'errors.22.1',
    'errors.22.2',
    'errors.22.3',
    'errors.22.4',
    'errors.22.5',
  ],
  23: [
    'errors.23.1',
  ],
  24: [
    'errors.24.1',
  ],
  26: [
    'errors.26.1',
    'errors.26.2',
    'errors.26.3',
    'errors.26.4',
    'errors.26.5',
    'errors.26.6',
    'errors.26.7',
    'errors.26.8',
  ],
  27: [
    'errors.27.1',
    'errors.27.2',
    'errors.27.3',
  ],
  28: [
    'errors.28.1',
    'errors.28.2',
  ],
  33: [
    'errors.33.1',
    'errors.33.2',
    'errors.33.3',
  ],
  34: [
    'errors.34.1',
  ],
  40: [
    'errors.40.1',
  ],
  41: [
    'errors.41.1',
  ],
  43: [
    'errors.43.1',
  ],
  50: [
    'errors.50.1',
  ],
  60: [
    'errors.60.1',
  ],
  1000: [
    'errors.1000.1',
  ],
};

const CAPABILITY_TYPES: Record<string, CapabilityType> = {
  onoff: 'boolean',
  target_temperature: 'number',
  measure_temperature: 'number',
  stove_eco_mode: 'boolean',
  stove_weekprogram_active: 'boolean',
  meta_eco_editable: 'boolean',
  measure_stove_cleaning_in: 'number',
  measure_stove_maintenance_in: 'number',
  measure_stove_consumption: 'number',
  measure_stove_pellets: 'number',
  stove_pellets_actual: 'number',
  stove_heating_curve: 'number',
  stove_ignitions: 'number',
  stove_on_time: 'number',
  stove_mode: 'string',
  stove_status: 'boolean',
  stove_zone: 'number',
  stove_error_state: 'boolean',
  stove_error_code: 'string',
};

const CAPABILITY_RENAMES: Record<string, string> = {
  stove_pellets: 'measure_stove_pellets',
  stove_cleaning_in: 'measure_stove_cleaning_in',
  stove_consumption: 'measure_stove_consumption',
  stove_maintenance_in: 'measure_stove_maintenance_in',
};

module.exports = class PelletStoveDevice extends Homey.Device {
  private api: HaasSohnApi | null = null;
  private pollInterval = 10;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private errorCount = 0;
  private ecoEditable = true;
  private lastErrorCode: string | null = null;
  private lastErrorMessage: string | null = null;
  private lastErrorSnapshot: string | null = null;
  private pelletsRemainingKg: number | null = null;
  private lastConsumptionKg: number | null = null;
  private pelletsAutoResetMode: PelletsAutoResetMode = 'none';
  private pelletsMaxKg = DEFAULT_MAX_PELLETS_KG;
  private pelletsHoldAutoReset = false;
  private suppressSettingsUpdate = false;
  private lastNonce: string | null = null;
  private lastCommandPayload: Record<string, unknown> | null = null;
  private lastCommandAt: number | null = null;

  async onInit() {
    this.log('Pellet stove device initialized');
    this.applySettings(this.getSettings());
    await this.syncCapabilities();
    this.initializePelletsState();
    this.registerCapabilityListeners();
    this.startPolling();
  }

  async onAdded() {
    this.log('Pellet stove device added');
  }

  async onSettings({
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    if (changedKeys.length === 0) {
      return;
    }
    if (this.suppressSettingsUpdate) {
      return;
    }

    if (changedKeys.some((key) => ['address', 'pin', 'pollInterval'].includes(key))) {
      this.applySettings(newSettings);
      this.startPolling();
    }

    if (changedKeys.includes('pellets_auto_reset')) {
      this.pelletsAutoResetMode = parsePelletsAutoResetMode(newSettings.pellets_auto_reset);
    }

    if (changedKeys.includes('pellets_max_kg')) {
      this.pelletsMaxKg = parsePelletsMaxKg(newSettings.pellets_max_kg);
      await this.updatePelletsCapabilityMax();
      if (this.pelletsRemainingKg !== null) {
        await this.setPelletsRemaining(this.pelletsRemainingKg, { updateSetting: true });
      }
    }

    if (changedKeys.includes('pellets_kg')) {
      await this.handlePelletsOverride(newSettings.pellets_kg);
    }
  }

  async onRenamed() {
    this.log('Pellet stove device renamed');
  }

  async onDeleted() {
    this.stopPolling();
    this.log('Pellet stove device deleted');
  }

  async setPelletsFromFlow(value: unknown) {
    await this.handlePelletsOverride(value);
  }

  getWidgetErrorMessage(): string | null {
    return this.lastErrorMessage;
  }

  getWidgetPelletCapacity(): number {
    return this.pelletsMaxKg;
  }

  async setWeeklyProgramFromFlow(value: unknown) {
    await this.handleWeekProgram(value);
  }

  async setEcoModeFromFlow(value: unknown) {
    await this.handleEcoMode(value);
  }

  private registerCapabilityListeners() {
    if (this.hasCapability('onoff')) {
      this.registerCapabilityListener('onoff', async (value) => this.handleOnOff(value));
    }
    if (this.hasCapability('target_temperature')) {
      this.registerCapabilityListener('target_temperature', async (value) => this.handleTargetTemperature(value));
    }
    if (this.hasCapability('stove_eco_mode')) {
      this.registerCapabilityListener('stove_eco_mode', async (value) => this.handleEcoMode(value));
    }
    if (this.hasCapability('stove_weekprogram_active')) {
      this.registerCapabilityListener('stove_weekprogram_active', async (value) => this.handleWeekProgram(value));
    }
    if (this.hasCapability('measure_stove_pellets')) {
      this.registerCapabilityListener('measure_stove_pellets', async (value) => this.handlePelletsOverride(value));
    }
  }

  private async syncCapabilities() {
    await this.migrateCapabilityIds();
    await this.ensureCapabilityPresent('stove_error_state');
    await this.ensureCapabilityPresent('stove_error_code');
    await this.ensureCapabilityPresent('stove_status');
    await this.ensureCapabilityAbsent('meta_raw');
    await this.ensureCapabilityAbsent('meta_hw_version');
    await this.ensureCapabilityAbsent('meta_sw_version');
    await this.ensureCapabilityAbsent('meta_typ');
    await this.ensureCapabilityPresent('stove_pellets_actual');
  }

  private async migrateCapabilityIds() {
    for (const [oldId, newId] of Object.entries(CAPABILITY_RENAMES)) {
      if (!this.hasCapability(oldId)) {
        continue;
      }
      if (!this.hasCapability(newId)) {
        try {
          await this.addCapability(newId);
        } catch (error) {
          this.error(`Failed to add capability ${newId}`, error);
          continue;
        }
      }
      const currentValue = this.getCapabilityValue(oldId);
      if (currentValue !== null && currentValue !== undefined) {
        try {
          await this.setCapabilityValue(newId, currentValue);
        } catch (error) {
          this.error(`Failed to migrate value from ${oldId} to ${newId}`, error);
        }
      }
      try {
        await this.removeCapability(oldId);
      } catch (error) {
        this.error(`Failed to remove capability ${oldId}`, error);
      }
    }
  }

  private async ensureCapabilityPresent(capabilityId: string) {
    if (this.hasCapability(capabilityId)) {
      return;
    }
    try {
      await this.addCapability(capabilityId);
    } catch (error) {
      this.error(`Failed to add capability ${capabilityId}`, error);
    }
  }

  private async ensureCapabilityAbsent(capabilityId: string) {
    if (!this.hasCapability(capabilityId)) {
      return;
    }
    try {
      await this.removeCapability(capabilityId);
    } catch (error) {
      this.error(`Failed to remove capability ${capabilityId}`, error);
    }
  }

  private applySettings(settings: { [key: string]: boolean | string | number | undefined | null }) {
    const address = normalizeAddress(settings.address, settings.port);
    const pin = String(settings.pin ?? '').trim();
    const pollInterval = Number(settings.pollInterval ?? 10);

    this.pollInterval = Number.isFinite(pollInterval) && pollInterval > 0 ? pollInterval : 10;
    this.pelletsAutoResetMode = parsePelletsAutoResetMode(settings.pellets_auto_reset);
    this.pelletsMaxKg = parsePelletsMaxKg(settings.pellets_max_kg);

    if (!this.api) {
      this.api = new HaasSohnApi(address, pin);
    } else {
      this.api.setConfig(address, pin);
    }

    this.logComms('Configuration applied', { address, pollInterval: this.pollInterval });
  }

  private initializePelletsState() {
    const settings = this.getSettings();
    const storedRemaining = this.getStoreValue('pelletsRemainingKg');
    const storedConsumption = this.getStoreValue('pelletsLastConsumptionKg');
    const configuredRemaining = coerceNumber(settings.pellets_kg);
    this.pelletsMaxKg = parsePelletsMaxKg(settings.pellets_max_kg);
    void this.updatePelletsCapabilityMax();

    if (typeof storedRemaining === 'number') {
      this.pelletsRemainingKg = this.clampPelletsValue(storedRemaining);
    } else if (typeof configuredRemaining === 'number') {
      this.pelletsRemainingKg = this.clampPelletsValue(configuredRemaining);
    } else {
      this.pelletsRemainingKg = this.clampPelletsValue(DEFAULT_PELLETS_KG);
    }

    if (typeof storedConsumption === 'number') {
      this.lastConsumptionKg = storedConsumption;
    }

    if (this.pelletsRemainingKg !== null) {
      void this.setCapabilityValueIfChanged('measure_stove_pellets', this.pelletsRemainingKg);
      void this.setCapabilityValueIfChanged('stove_pellets_actual', this.pelletsRemainingKg);
    }
  }

  private async updateMetaSettings(flat: Record<string, unknown>) {
    const settings = this.getSettings();
    const updates: Record<string, string> = {};

    const hwVersion = normalizeMetaValue(flat['meta.hw_version']);
    const swVersion = normalizeMetaValue(flat['meta.sw_version']);
    const deviceType = normalizeMetaValue(flat['meta.typ']);

    if (hwVersion !== undefined && hwVersion !== String(settings.meta_hw_version ?? '')) {
      updates.meta_hw_version = hwVersion;
    }
    if (swVersion !== undefined && swVersion !== String(settings.meta_sw_version ?? '')) {
      updates.meta_sw_version = swVersion;
    }
    if (deviceType !== undefined && deviceType !== String(settings.meta_typ ?? '')) {
      updates.meta_typ = deviceType;
    }

    if (Object.keys(updates).length > 0) {
      this.logComms('Device metadata updated', updates);
      await this.updateSettingsSafely(updates);
    }
  }

  private async updatePelletsFromConsumption(consumptionKg: number) {
    if (!Number.isFinite(consumptionKg)) {
      return;
    }

    if (this.pelletsRemainingKg === null) {
      this.initializePelletsState();
    }

    if (this.lastConsumptionKg === null) {
      this.lastConsumptionKg = consumptionKg;
      await this.setStoreValue('pelletsLastConsumptionKg', consumptionKg);
      if (this.pelletsRemainingKg !== null) {
        await this.setCapabilityValueIfChanged('measure_stove_pellets', this.pelletsRemainingKg);
        await this.setCapabilityValueIfChanged('stove_pellets_actual', this.pelletsRemainingKg);
      }
      return;
    }

    let delta = consumptionKg - this.lastConsumptionKg;
    if (!Number.isFinite(delta) || delta < 0) {
      delta = 0;
    }

    const currentRemaining = this.pelletsRemainingKg ?? 0;
    let nextRemaining = this.clampPelletsValue(currentRemaining - delta);

    if (nextRemaining === 0) {
      const resetValue = getPelletsAutoResetValue(this.pelletsAutoResetMode);
      if (resetValue !== null && !this.pelletsHoldAutoReset) {
        nextRemaining = resetValue;
      }
    }

    this.lastConsumptionKg = consumptionKg;
    await this.setStoreValue('pelletsLastConsumptionKg', consumptionKg);
    await this.setPelletsRemaining(nextRemaining, { updateSetting: true });
  }

  private async handlePelletsOverride(value: unknown) {
    const normalized = coerceNumber(value);
    if (typeof normalized !== 'number') {
      throw new Error('Invalid pellets value');
    }

    this.pelletsHoldAutoReset = false;
    await this.setPelletsRemaining(normalized, { updateSetting: true });
  }

  private async setPelletsRemaining(value: number, { updateSetting }: { updateSetting?: boolean } = {}) {
    const normalized = this.clampPelletsValue(value);
    if (this.pelletsRemainingKg === normalized) {
      if (updateSetting) {
        await this.updatePelletsSetting(normalized);
      }
      return;
    }

    this.pelletsRemainingKg = normalized;
    await this.setStoreValue('pelletsRemainingKg', normalized);
    await this.setCapabilityValueIfChanged('measure_stove_pellets', normalized);
    await this.setCapabilityValueIfChanged('stove_pellets_actual', normalized);
    if (updateSetting) {
      await this.updatePelletsSetting(normalized);
    }
  }

  private async updatePelletsSetting(value: number) {
    const settings = this.getSettings();
    const current = coerceNumber(settings.pellets_kg);
    if (typeof current === 'number' && Math.abs(current - value) < 0.01) {
      return;
    }
    await this.updateSettingsSafely({ pellets_kg: value });
  }

  private async updatePelletsCapabilityMax() {
    if (!this.hasCapability('measure_stove_pellets')) {
      return;
    }
    try {
      await this.setCapabilityOptions('measure_stove_pellets', { max: this.pelletsMaxKg });
    } catch (error) {
      this.error('Failed to update pellets capability max', error);
    }
  }

  private clampPelletsValue(value: number): number {
    if (!Number.isFinite(value)) {
      return DEFAULT_PELLETS_KG;
    }
    const rounded = Math.round(value);
    return Math.min(this.pelletsMaxKg, Math.max(MIN_PELLETS_KG, rounded));
  }

  private async updateSettingsSafely(updates: Record<string, string | number | boolean>) {
    try {
      this.suppressSettingsUpdate = true;
      await this.setSettings(updates);
    } finally {
      this.suppressSettingsUpdate = false;
    }
  }

  private startPolling() {
    this.stopPolling();
    this.scheduleNextPoll(0);
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private scheduleNextPoll(delaySeconds: number) {
    const delayMs = Math.max(0, delaySeconds) * 1000;
    this.pollTimer = setTimeout(() => {
      void this.pollStatus();
    }, delayMs);
  }

  private async pollStatus(context: { reason?: 'poll' | 'command' | 'manual' } = {}) {
    if (!this.api) {
      return;
    }
    if (this.pollInFlight) {
      return;
    }
    this.pollInFlight = true;
    const reason = context.reason ?? 'poll';
    const previousErrorCount = this.errorCount;

    try {
      const address = this.api.getAddress().trim();
      if (!address) {
        await this.setUnavailable('Missing device address');
        return;
      }
      if (reason !== 'poll') {
        this.logComms(`Polling status (${reason})`, { address });
      }

      const status = await this.api.getStatus();
      const nonce = this.api.getNonce();
      if (nonce && nonce !== this.lastNonce) {
        this.logComms(this.lastNonce ? 'Session nonce refreshed' : 'Session nonce initialized');
        this.lastNonce = nonce;
      }

      const flat = await this.applyStatus(status);
      if (reason !== 'poll') {
        this.logStatusSummary(flat, reason);
      }
      this.errorCount = 0;
      await this.setAvailable();
      if (previousErrorCount > 0) {
        this.logComms('Polling recovered', { attempts: previousErrorCount });
      }
      if (reason === 'command') {
        this.logCommandEcho(flat);
      }
    } catch (error) {
      this.errorCount += 1;
      this.error(`Polling failed (${this.errorCount})`, error);
      await this.setUnavailable('Unable to reach device');
    } finally {
      this.pollInFlight = false;
      this.scheduleNextPoll(this.pollInterval);
    }
  }

  private async applyStatus(status: HaasSohnStatus): Promise<Record<string, unknown>> {
    const flat = flattenStatus(status);
    const ecoEditable = coerceBoolean(flat['meta.eco_editable']);
    if (typeof ecoEditable === 'boolean') {
      if (this.ecoEditable !== ecoEditable) {
        this.logComms('Eco mode editable changed', { ecoEditable });
      }
      this.ecoEditable = ecoEditable;
    }

    await this.applyErrorState(flat);
    await this.updateMetaSettings(flat);

    if ('cleaning_in' in flat) {
      const minutes = coerceNumber(flat.cleaning_in);
      if (typeof minutes === 'number') {
        const hours = minutes / 60;
        await this.setCapabilityValueIfChanged('measure_stove_cleaning_in', roundTo(hours, 1));
      }
    }

    if ('maintenance_in' in flat) {
      const maintenanceKg = coerceNumber(flat.maintenance_in);
      if (typeof maintenanceKg === 'number') {
        const percent = 100 - (maintenanceKg / 1000) * 100;
        const clamped = Math.min(100, Math.max(0, percent));
        await this.setCapabilityValueIfChanged('measure_stove_maintenance_in', roundTo(clamped, 1));
      }
    }

    const consumption = coerceNumber(flat['consumption']);
    if (typeof consumption === 'number') {
      await this.updatePelletsFromConsumption(consumption);
    }

    for (const [stateKey, capabilityId] of Object.entries(STATE_TO_CAPABILITY)) {
      if (!(stateKey in flat)) {
        continue;
      }
      if (stateKey === 'cleaning_in' || stateKey === 'maintenance_in') {
        continue;
      }
      const value = coerceValue(capabilityId, flat[stateKey]);
      if (value === undefined) {
        continue;
      }
      await this.setCapabilityValueIfChanged(capabilityId, value);
    }

    const modeValue = typeof flat.mode === 'string' ? flat.mode.trim().toLowerCase() : null;
    if (modeValue && (modeValue === 'shutdown' || modeValue === 'off')) {
      await this.setCapabilityValueIfChanged('onoff', false);
    }

    const stoveStatus = deriveStoveStatus(flat.mode);
    if (typeof stoveStatus === 'boolean') {
      await this.setCapabilityValueIfChanged('stove_status', stoveStatus);
    }

    return flat;
  }

  private async applyErrorState(flat: Record<string, unknown>) {
    this.logRawErrorFields(flat);
    const errorNumber = getErrorNumber(flat);
    if (errorNumber === undefined) {
      if (!hasAnyErrorField(flat)) {
        await this.clearErrorState();
      }
      return;
    }
    if (!errorNumber || errorNumber === 0) {
      await this.clearErrorState();
      return;
    }

    if (errorNumber === 2) {
      this.pelletsHoldAutoReset = false;
      const resetValue = getPelletsAutoResetValue(this.pelletsAutoResetMode);
      if (resetValue !== null) {
        await this.setPelletsRemaining(resetValue, { updateSetting: true });
      }
    } else if (errorNumber === 21 || errorNumber === 26) {
      this.pelletsHoldAutoReset = true;
      await this.setPelletsRemaining(0, { updateSetting: true });
    } else {
      this.pelletsHoldAutoReset = false;
    }

    const errorCode = formatErrorCode(errorNumber);
    await this.setCapabilityValueIfChanged('stove_error_code', errorCode);
    const errorCauses = (ERROR_CODE_MAP[errorNumber] ?? [])
      .map((key) => this.homey.__(key))
      .filter((cause) => typeof cause === 'string' && cause.trim().length > 0);
    const errorMessage = formatErrorMessage(errorCode, errorCauses, this.homey.__('errors.unknown'));

    await this.setCapabilityValueIfChanged('stove_error_state', true);

    if (this.lastErrorCode !== errorCode) {
      await this.triggerErrorFlow(errorCode, errorMessage);
      await this.setWarning(errorMessage);
      await this.createErrorNotification(errorMessage);
      this.lastErrorCode = errorCode;
      this.lastErrorMessage = errorMessage;
      return;
    }

    if (this.lastErrorMessage !== errorMessage) {
      await this.setWarning(errorMessage);
      this.lastErrorMessage = errorMessage;
    }
  }

  private async clearErrorState() {
    this.lastErrorSnapshot = null;
    this.pelletsHoldAutoReset = false;
    await this.setCapabilityValueIfChanged('stove_error_state', false);
    await this.setCapabilityValueIfChanged('stove_error_code', '');
    await this.unsetWarning();
    this.lastErrorCode = null;
    this.lastErrorMessage = null;
  }

  private async createErrorNotification(message: string) {
    try {
      await this.homey.notifications.createNotification({
        excerpt: `${this.getName()}: ${message}`,
      });
    } catch (error) {
      this.error('Failed to create error notification', error);
    }
  }

  private async triggerErrorFlow(errorCode: string, errorMessage: string) {
    try {
      const card = this.homey.flow.getDeviceTriggerCard('stove_error');
      await card.trigger(this, {
        error_code: errorCode,
        error_message: errorMessage,
      });
    } catch (error) {
      this.error('Failed to trigger error flow', error);
    }
  }

  private async setCapabilityValueIfChanged(capabilityId: string, value: unknown): Promise<boolean> {
    if (!this.hasCapability(capabilityId)) {
      return false;
    }
    const currentValue = this.getCapabilityValue(capabilityId);
    if (Object.is(currentValue, value)) {
      return false;
    }
    try {
      await this.setCapabilityValue(capabilityId, value);
      await this.triggerCapabilityFlow(capabilityId, value);
      if (shouldLogCapabilityChange(capabilityId)) {
        this.logComms('Capability changed', {
          capabilityId,
          from: currentValue,
          to: value,
        });
      }
      return true;
    } catch (error) {
      this.error(`Failed to update capability ${capabilityId}`, error);
    }
    return false;
  }

  private async triggerCapabilityFlow(capabilityId: string, value: unknown) {
    if (capabilityId === 'stove_weekprogram_active') {
      const enabled = coerceBoolean(value);
      if (typeof enabled !== 'boolean') {
        return;
      }
      await this.triggerWeekProgramFlow(enabled);
      return;
    }
    if (capabilityId === 'stove_eco_mode') {
      const mode = coerceBoolean(value);
      if (typeof mode !== 'boolean') {
        return;
      }
      await this.triggerEcoModeFlow(mode);
      return;
    }
    if (capabilityId === 'stove_pellets_actual' || capabilityId === 'measure_stove_pellets') {
      if (capabilityId === 'measure_stove_pellets' && this.hasCapability('stove_pellets_actual')) {
        return;
      }
      const pelletsKg = coerceNumber(value);
      if (typeof pelletsKg !== 'number') {
        return;
      }
      await this.triggerPelletsFlow(pelletsKg);
      return;
    }
    if (capabilityId === 'measure_stove_cleaning_in') {
      const cleaningHours = coerceNumber(value);
      if (typeof cleaningHours !== 'number') {
        return;
      }
      await this.triggerCleaningFlow(cleaningHours);
      return;
    }
    if (capabilityId === 'measure_stove_maintenance_in') {
      const ashLimit = coerceNumber(value);
      if (typeof ashLimit !== 'number') {
        return;
      }
      await this.triggerAshLimitFlow(ashLimit);
    }
  }

  private async triggerWeekProgramFlow(enabled: boolean) {
    try {
      const card = this.homey.flow.getDeviceTriggerCard('stove_weekprogram_changed');
      await card.trigger(this, { enabled });
    } catch (error) {
      this.error('Failed to trigger week program flow', error);
    }
  }

  private async triggerEcoModeFlow(mode: boolean) {
    try {
      const card = this.homey.flow.getDeviceTriggerCard('stove_eco_mode_changed');
      await card.trigger(this, { mode });
    } catch (error) {
      this.error('Failed to trigger eco mode flow', error);
    }
  }

  private async triggerPelletsFlow(pelletsKg: number) {
    try {
      const card = this.homey.flow.getDeviceTriggerCard('stove_pellets_changed');
      await card.trigger(this, { pellets_kg: pelletsKg });
    } catch (error) {
      this.error('Failed to trigger pellets flow', error);
    }
  }

  private async triggerCleaningFlow(cleaningHours: number) {
    try {
      const card = this.homey.flow.getDeviceTriggerCard('stove_cleaning_changed');
      await card.trigger(this, { cleaning_hours: cleaningHours });
    } catch (error) {
      this.error('Failed to trigger cleaning flow', error);
    }
  }

  private async triggerAshLimitFlow(ashLimitPercent: number) {
    try {
      const card = this.homey.flow.getDeviceTriggerCard('stove_ash_limit_changed');
      await card.trigger(this, { ash_limit_percent: ashLimitPercent });
    } catch (error) {
      this.error('Failed to trigger ash limit flow', error);
    }
  }

  private logRawErrorFields(flat: Record<string, unknown>) {
    const raw = {
      error: flat['error'],
      error_nr: flat['error.nr'],
      err: flat['err'],
      err_nr: flat['err.nr'],
    };

    if (Object.values(raw).every((value) => value === undefined)) {
      return;
    }

    let snapshot: string;
    try {
      snapshot = JSON.stringify(raw);
    } catch (error) {
      snapshot = String(raw);
    }

    if (snapshot === this.lastErrorSnapshot) {
      return;
    }

    this.lastErrorSnapshot = snapshot;
    const parsed = getErrorNumber(flat);
    this.logComms('Error fields', { ...raw, parsed });
  }

  private async handleOnOff(value: unknown) {
    const normalized = coerceBoolean(value);
    if (typeof normalized !== 'boolean') {
      throw new Error('Invalid on/off value');
    }
    await this.sendCommand({ prg: normalized });
  }

  private async handleTargetTemperature(value: unknown) {
    if (this.getCapabilityValue('stove_weekprogram_active') === true) {
      throw new Error('Weekly program is active');
    }
    const normalized = coerceNumber(value);
    if (typeof normalized !== 'number') {
      throw new Error('Invalid target temperature');
    }
    await this.sendCommand({ sp_temp: normalized });
  }

  private async handleEcoMode(value: unknown) {
    if (!this.ecoEditable) {
      throw new Error('Eco mode is not editable');
    }
    const normalized = coerceBoolean(value);
    if (typeof normalized !== 'boolean') {
      throw new Error('Invalid eco mode value');
    }
    await this.sendCommand({ eco_mode: normalized });
  }

  private async handleWeekProgram(value: unknown) {
    const normalized = coerceBoolean(value);
    if (typeof normalized !== 'boolean') {
      throw new Error('Invalid weekly program value');
    }
    await this.sendCommand({ wprg: normalized });
  }


  private async sendCommand(payload: Record<string, unknown>) {
    if (!this.api) {
      throw new Error('Device not configured');
    }
    this.lastCommandPayload = { ...payload };
    this.lastCommandAt = Date.now();
    this.logComms('Sending command', { payload: this.lastCommandPayload });
    this.stopPolling();
    let polledAfterCommand = false;
    try {
      await this.api.postStatus(payload);
      this.logComms('Command posted');
      polledAfterCommand = true;
      await this.pollStatus({ reason: 'command' });
    } catch (error) {
      if (this.lastCommandPayload) {
        this.logComms('Command failed', { payload: this.lastCommandPayload });
      }
      throw error;
    } finally {
      if (!polledAfterCommand && !this.pollInFlight) {
        this.scheduleNextPoll(this.pollInterval);
      }
    }
  }

  private logComms(message: string, details?: Record<string, unknown>) {
    const suffix = details && Object.keys(details).length > 0 ? ` ${stringifyLogDetails(details)}` : '';
    this.log(`[Comms] ${message}${suffix}`);
  }

  private logStatusSummary(flat: Record<string, unknown>, reason: string) {
    const summary: Record<string, unknown> = {};
    for (const key of STATUS_SUMMARY_KEYS) {
      if (key in flat) {
        summary[key] = flat[key];
      }
    }
    if (Object.keys(summary).length === 0) {
      return;
    }
    this.logComms(`Status summary (${reason})`, summary);
  }

  private logCommandEcho(flat: Record<string, unknown>) {
    if (!this.lastCommandPayload || !this.lastCommandAt) {
      return;
    }
    const ageMs = Date.now() - this.lastCommandAt;
    if (ageMs > 30000) {
      this.lastCommandPayload = null;
      this.lastCommandAt = null;
      return;
    }

    const confirmed: Record<string, unknown> = {};
    const mismatched: Record<string, { expected: unknown; actual: unknown }> = {};

    for (const [key, expected] of Object.entries(this.lastCommandPayload)) {
      if (!(key in flat)) {
        mismatched[key] = { expected, actual: undefined };
        continue;
      }
      const actual = flat[key];
      if (areValuesEquivalent(expected, actual)) {
        confirmed[key] = actual;
      } else {
        mismatched[key] = { expected, actual };
      }
    }

    if (Object.keys(confirmed).length > 0) {
      this.logComms('Command read-back confirmed', confirmed);
    }
    if (Object.keys(mismatched).length > 0) {
      this.logComms('Command read-back mismatch', mismatched);
    }

    this.lastCommandPayload = null;
    this.lastCommandAt = null;
  }
};

const STATUS_SUMMARY_KEYS = [
  'mode',
  'is_temp',
  'sp_temp',
  'eco_mode',
  'wprg',
  'error',
  'error.nr',
  'err.nr',
  'err',
];

const STOVE_STATUS_HEATING_MODES = new Set([
  'heating',
  'start',
  'startup',
  'ignite',
  'ignition',
  'run',
  'running',
]);

const STOVE_STATUS_STANDBY_MODES = new Set([
  'standby',
  'shutdown',
  'cooling',
  'idle',
  'off',
  'stop',
]);

const ERROR_STATE_KEYS = ['error', 'error.nr', 'err', 'err.nr'];

function shouldLogCapabilityChange(capabilityId: string): boolean {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_TYPES, capabilityId);
}

function hasAnyErrorField(flat: Record<string, unknown>): boolean {
  return ERROR_STATE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(flat, key));
}

function stringifyLogDetails(details: Record<string, unknown>): string {
  try {
    return JSON.stringify(details);
  } catch (error) {
    return '[unserializable]';
  }
}

function areValuesEquivalent(expected: unknown, actual: unknown): boolean {
  if (typeof expected === 'boolean') {
    const coerced = coerceBoolean(actual);
    return typeof coerced === 'boolean' && coerced === expected;
  }
  if (typeof expected === 'number') {
    const coerced = coerceNumber(actual);
    return typeof coerced === 'number' && Math.abs(coerced - expected) < 0.001;
  }
  if (typeof expected === 'string') {
    return String(actual) === expected;
  }
  return Object.is(expected, actual);
}

function flattenStatus(status: HaasSohnStatus, path = '', output: Record<string, unknown> = {}) {
  Object.entries(status).forEach(([key, value]) => {
    const fullKey = path ? `${path}.${key}` : key;
    if (value && typeof value === 'object') {
      if (Array.isArray(value) || OBJECT_AS_STRING_KEYS.has(fullKey)) {
        output[fullKey] = JSON.stringify(value);
      } else {
        flattenStatus(value as HaasSohnStatus, fullKey, output);
      }
    } else {
      output[fullKey] = value;
    }
  });
  return output;
}

function coerceValue(capabilityId: string, value: unknown): boolean | number | string | undefined {
  const type = CAPABILITY_TYPES[capabilityId];
  if (!type) {
    return undefined;
  }

  if (type === 'boolean') {
    return coerceBoolean(value);
  }
  if (type === 'number') {
    return coerceNumber(value);
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    return undefined;
  }
}

function deriveStoveStatus(modeValue: unknown): boolean | undefined {
  if (typeof modeValue !== 'string') {
    return undefined;
  }
  const normalized = modeValue.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (STOVE_STATUS_STANDBY_MODES.has(normalized)) {
    return false;
  }
  if (STOVE_STATUS_HEATING_MODES.has(normalized)) {
    return true;
  }
  return undefined;
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lowered)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(lowered)) {
      return false;
    }
  }
  return undefined;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function getErrorNumber(flat: Record<string, unknown>): number | undefined {
  const errorNrCandidates = [flat['error.nr'], flat['err.nr']];
  const errorCandidates = [flat['error'], flat['err']];

  const normalizedErrorNr = selectErrorCandidate(errorNrCandidates);
  if (normalizedErrorNr !== undefined) {
    return normalizedErrorNr;
  }

  return selectErrorCandidate(errorCandidates);
}

function parseErrorNumber(value: unknown): number | undefined {
  const direct = coerceNumber(value);
  if (direct !== undefined) {
    return direct;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsedJson = JSON.parse(trimmed) as unknown;
        const fromJson = extractErrorNumberFromJson(parsedJson);
        if (fromJson !== undefined) {
          return fromJson;
        }
      } catch (error) {
        // fall through to regex parsing
      }
    }

    const match = trimmed.match(/(\d{1,4})/);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function extractErrorNumberFromJson(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    return extractErrorNumberFromArray(value);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const nr = coerceNumber(record.nr);
    if (nr !== undefined) {
      return nr;
    }
    const error = coerceNumber(record.error);
    if (error !== undefined) {
      return error;
    }
  }
  return undefined;
}

function extractErrorNumberFromArray(value: unknown[]): number | undefined {
  if (value.length === 0) {
    return 0;
  }

  const candidates: { nr: number; index: number; timeMs: number | undefined }[] = [];

  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    const nr = extractErrorNumberFromJson(entry);
    if (nr === undefined) {
      continue;
    }

    let timeMs: number | undefined;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      timeMs = parseErrorTimestamp(record.time);
    }

    candidates.push({ nr, index: i, timeMs });
  }

  if (candidates.length === 0) {
    return undefined;
  }

  const withTimestamp = candidates.filter((candidate) => candidate.timeMs !== undefined);
  if (withTimestamp.length > 0) {
    withTimestamp.sort((a, b) => {
      if (a.timeMs === b.timeMs) {
        return a.index - b.index;
      }
      return (b.timeMs ?? 0) - (a.timeMs ?? 0);
    });
    return withTimestamp[0].nr;
  }

  // Fallback to first entry. The stove reports newest errors first in normal responses.
  return candidates[0].nr;
}

function parseErrorTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const isoMs = Date.parse(trimmed);
  if (Number.isFinite(isoMs)) {
    return isoMs;
  }

  const match = trimmed.match(
    /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/,
  );
  if (!match) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const hour = Number(match[4] ?? '0');
  const minute = Number(match[5] ?? '0');
  const second = Number(match[6] ?? '0');
  const timeMs = Date.UTC(year, month, day, hour, minute, second);
  return Number.isFinite(timeMs) ? timeMs : undefined;
}

function selectErrorCandidate(candidates: unknown[]): number | undefined {
  let fallback: number | undefined;
  let zeroFound = false;

  for (const candidate of candidates) {
    const parsed = parseErrorNumber(candidate);
    if (parsed === undefined) {
      continue;
    }
    if (parsed === 0) {
      zeroFound = true;
      continue;
    }
    if (hasErrorMapping(parsed)) {
      return parsed;
    }
    if (fallback === undefined) {
      fallback = parsed;
    }
  }

  if (fallback !== undefined) {
    return fallback;
  }

  if (zeroFound) {
    return 0;
  }

  return undefined;
}

function hasErrorMapping(errorNumber: number): boolean {
  return Object.prototype.hasOwnProperty.call(ERROR_CODE_MAP, errorNumber);
}

function formatErrorCode(errorNumber: number): string {
  if (errorNumber >= 1000) {
    return `F${errorNumber}`;
  }
  return `F${String(errorNumber).padStart(3, '0')}`;
}

function formatErrorMessage(errorCode: string, causes: string[], unknownMessage: string): string {
  if (!causes || causes.length === 0) {
    return `${errorCode}: ${unknownMessage}`;
  }
  return `${errorCode}: ${causes.join(' / ')}`;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function parsePelletsAutoResetMode(value: unknown): PelletsAutoResetMode {
  if (value === 'reset15' || value === 'reset30') {
    return value;
  }
  return 'none';
}

function parsePelletsMaxKg(value: unknown): number {
  const parsed = coerceNumber(value);
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    return DEFAULT_MAX_PELLETS_KG;
  }
  return Math.max(MIN_PELLETS_KG, parsed);
}

function getPelletsAutoResetValue(mode: PelletsAutoResetMode): number | null {
  if (mode === 'reset15') {
    return 15;
  }
  if (mode === 'reset30') {
    return 30;
  }
  return null;
}

function normalizeMetaValue(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    return undefined;
  }
}

function normalizeAddress(address?: string | number | boolean | null, port?: string | number | boolean | null): string {
  const trimmed = String(address ?? '').trim();
  if (!trimmed) return '';
  const portNumber = Number(port);
  if (Number.isFinite(portNumber)) {
    if (!/:\d+$/.test(trimmed)) {
      return `${trimmed}:${portNumber}`;
    }
  }
  return trimmed;
}
