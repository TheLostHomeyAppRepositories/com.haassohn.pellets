'use strict';

import Homey from 'homey';

module.exports = class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Haas+Sohn stove app has been initialized');
    this.registerFlowCards();
    this.registerStoveWidget();
  }

  private registerStoveWidget() {
    this.homey.dashboards.getWidget('stove').registerSettingAutocompleteListener('stove', async (query) => {
      const driver = this.homey.drivers.getDriver('pellet_stove');
      await driver.ready();
      return driver.getDevices()
        .map((device) => ({ name: device.getName(), id: device.getData().id }))
        .filter((device) => device.name.toLowerCase().includes(query.toLowerCase()));
    });
  }

  private registerFlowCards() {
    const setPelletsCard = this.homey.flow.getActionCard('set_pellets');
    setPelletsCard.registerRunListener(async (args: { device: { setPelletsFromFlow: (value: unknown) => Promise<void> }; pellets_kg: number }) => {
      await args.device.setPelletsFromFlow(args.pellets_kg);
      return true;
    });

    const setWeekProgramCard = this.homey.flow.getActionCard('set_weekprogram');
    setWeekProgramCard.registerRunListener(async (args: { device: { setWeeklyProgramFromFlow: (value: unknown) => Promise<void> }; enabled: boolean }) => {
      await args.device.setWeeklyProgramFromFlow(args.enabled);
      return true;
    });

    const setEcoModeCard = this.homey.flow.getActionCard('set_eco_mode');
    setEcoModeCard.registerRunListener(async (args: { device: { setEcoModeFromFlow: (value: unknown) => Promise<void> }; mode: string }) => {
      await args.device.setEcoModeFromFlow(args.mode);
      return true;
    });
  }

};
