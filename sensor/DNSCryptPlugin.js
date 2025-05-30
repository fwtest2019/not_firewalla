/*    Copyright 2016-2023 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';

const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const extensionManager = require('./ExtensionManager.js')
const sem = require('../sensor/SensorEventManager.js').getInstance();

const f = require('../net2/Firewalla.js');

const userConfigFolder = f.getUserConfigFolder();
const dnsmasqConfigFolder = `${userConfigFolder}/dnsmasq`;

const NetworkProfileManager = require('../net2/NetworkProfileManager.js');
const NetworkProfile = require('../net2/NetworkProfile.js');
const TagManager = require('../net2/TagManager.js');
const IdentityManager = require('../net2/IdentityManager.js');

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const exec = require('child-process-promise').exec;

const featureName = "doh";
const fc = require('../net2/config.js');

const dc = require('../extension/dnscrypt/dnscrypt');
const Constants = require('../net2/Constants.js');

class DNSCryptPlugin extends Sensor {
  async run() {
    this.refreshInterval = (this.config.refreshInterval || 24 * 60) * 60 * 1000;
    this.systemSwitch = false;
    this.adminSystemSwitch = false;
    this.networkSettings = {};
    this.tagSettings = {};
    this.macAddressSettings = {};
    this.identitySettings = {};

    extensionManager.registerExtension(featureName, this, {
      applyPolicy: this.applyPolicy,
      start: this.globalOn,
      stop: this.globalOff,
    });

    await exec(`mkdir -p ${dnsmasqConfigFolder}`);

    this.hookFeature(featureName);

    sem.on('DOH_REFRESH', (event) => {
      this.applyDoH();
    });

    sem.on('DOH_RESET', async () => {
      try {
        await fc.disableDynamicFeature(featureName)
        for (const tag in this.tagSettings) this.tagSettings[tag] = 0
        for (const uuid in this.networkSettings) this.networkSettings[uuid] = 0
        for (const mac in this.macAddressSettings) this.macAddressSettings[mac] = 0
        for (const guid in this.identitySettings) this.identitySettings[guid] = 0
        await this.applyDoH();
        await dc.resetSettings()
      } catch(err) {
        log.error('Error reseting DoH', err)
      }
    });
  }

  async job() {
    await this.applyDoH(true);
  }

  async apiRun() {
    extensionManager.onSet("dohConfig", async (msg, data) => {
      try {await extensionManager._precedeRecord(msg.id, {origin:{servers: await dc.getServers()}})} catch(err) {};
      if (data && data.servers) {
        await dc.setServers(data.servers, false)
        sem.sendEventToFireMain({
          type: 'DOH_REFRESH'
        });
      }
    });

    extensionManager.onSet("customizedDohServers", async (msg, data) => {
      try {await extensionManager._precedeRecord(msg.id, {origin:{customizedServers: await dc.getCustomizedServers()}})} catch(err) {};
      if (data && data.servers) {
        await dc.setServers(data.servers, true);
      }
    });

    extensionManager.onGet("dohConfig", async (msg, data) => {
      const selectedServers = await dc.getServers();
      const customizedServers = await dc.getCustomizedServers();
      const allServers = await dc.getAllServerNames();
      return {
        selectedServers, allServers, customizedServers
      }
    });

    extensionManager.onCmd("dohReset", async (msg, data) => {
      try {await extensionManager._precedeRecord(msg.id, {origin: {
        servers: await dc.getServers(), customizedServers: await dc.getCustomizedServers(), allServers: await dc.getAllServerNames(),
        enabled: fc.isFeatureOn(featureName)}})
      } catch(err) {};
      sem.sendEventToFireMain({
        type: 'DOH_RESET'
      });
    });
  }

  // global policy apply
  async applyPolicy(host, ip, policy) {
    log.info("Applying DoH policy:", ip, policy);
    try {
      if (ip === '0.0.0.0') {
        if (policy && policy.state) {
          this.systemSwitch = true;
        } else {
          this.systemSwitch = false;
        }
        return this.applySystemDoH();
      } else {
        if (!host)
          return;
        switch (host.constructor.name) {
          case "Tag": {
            const tagUid = host.o && host.o.uid;
            if (tagUid) {
              if (policy && policy.state === true)
                this.tagSettings[tagUid] = 1;
              // false means unset, this is for backward compatibility
              if (policy && policy.state === false)
                this.tagSettings[tagUid] = 0;
              // null means disabled, this is for backward compatibility
              if (policy && policy.state === null)
                this.tagSettings[tagUid] = -1;
              await this.applyTagDoH(tagUid);
            }
            break;
          }
          case "NetworkProfile": {
            const uuid = host.o && host.o.uuid;
            if (uuid) {
              if (policy && policy.state === true)
                this.networkSettings[uuid] = 1;
              if (policy && policy.state === false)
                this.networkSettings[uuid] = 0;
              if (policy && policy.state === null)
                this.networkSettings[uuid] = -1;
              await this.applyNetworkDoH(uuid);
            }
            break;
          }
          case "Host": {
            const macAddress = host && host.o && host.o.mac;
            if (macAddress) {
              if (policy && policy.state === true)
                this.macAddressSettings[macAddress] = 1;
              if (policy && policy.state === false)
                this.macAddressSettings[macAddress] = 0;
              if (policy && policy.state === null)
                this.macAddressSettings[macAddress] = -1;
              await this.applyDeviceDoH(macAddress);
            }
            break;
          }
          default:
            if (IdentityManager.isIdentity(host)) {
              const guid = IdentityManager.getGUID(host);
              if (guid) {
                if (policy && policy.state === true)
                  this.identitySettings[guid] = 1;
                if (policy && policy.state === false)
                  this.identitySettings[guid] = 0;
                if (policy && policy.state === null)
                  this.identitySettings[guid] = -1;
                await this.applyIdentityDoH(guid);
              }
            }
        }
      }
    } catch (err) {
      log.error("Got error when applying DoH policy", err);
    }
  }

  async applyDoH(reCheckConfig = false) {
    if (!fc.isFeatureOn(featureName)) {
      await dc.stop();
    } else {
      const result = await dc.prepareConfig({}, reCheckConfig);
      if (result) {
        await dc.restart();
      } else {
        await dc.start();
      }
    }
    const configFilePath = `${dnsmasqConfigFolder}/${featureName}.conf`;
    if (this.adminSystemSwitch) {
      const dnsmasqEntry = `server=${dc.getLocalServer()}$${featureName}$*${Constants.DNS_DEFAULT_WAN_TAG}`;
      await fs.writeFileAsync(configFilePath, dnsmasqEntry);
    } else {
      await fs.unlinkAsync(configFilePath).catch((err) => { });
    }

    await this.applySystemDoH();
    for (const macAddress in this.macAddressSettings) {
      await this.applyDeviceDoH(macAddress);
    }
    for (const tagUid in this.tagSettings) {
      const tagExists = await TagManager.tagUidExists(tagUid);
      if (!tagExists)
        // reset tag if it is already deleted
        this.tagSettings[tagUid] = 0;
      await this.applyTagDoH(tagUid);
      if (!tagExists)
        delete this.tagSettings[tagUid];
    }
    for (const uuid in this.networkSettings) {
      const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
      if (!networkProfile)
        delete this.networkSettings[uuid];
      else
        await this.applyNetworkDoH(uuid);
    }
    for (const guid in this.identitySettings) {
      const identity = IdentityManager.getIdentityByGUID(guid);
      if (!identity)
        delete this.identitySettings[guid];
      else
        await this.applyIdentityDoH(guid);
    }
  }

  async applySystemDoH() {
    if (this.systemSwitch) {
      return this.systemStart();
    } else {
      return this.systemStop();
    }
  }

  async applyTagDoH(tagUid) {
    if (this.tagSettings[tagUid] == 1)
      return this.perTagStart(tagUid);
    if (this.tagSettings[tagUid] == -1)
      return this.perTagStop(tagUid);
    return this.perTagReset(tagUid);
  }

  async applyNetworkDoH(uuid) {
    if (this.networkSettings[uuid] == 1)
      return this.perNetworkStart(uuid);
    if (this.networkSettings[uuid] == -1)
      return this.perNetworkStop(uuid);
    return this.perNetworkReset(uuid);
  }

  async applyDeviceDoH(macAddress) {
    if (this.macAddressSettings[macAddress] == 1)
      return this.perDeviceStart(macAddress);
    if (this.macAddressSettings[macAddress] == -1)
      return this.perDeviceStop(macAddress);
    return this.perDeviceReset(macAddress);
  }

  async applyIdentityDoH(guid) {
    if (this.identitySettings[guid] == 1)
      return this.perIdentityStart(guid);
    if (this.identitySettings[guid] == -1)
      return this.perIdentityStop(guid);
    return this.perIdentityReset(guid);
  }

  async systemStart() {
    const configFile = `${dnsmasqConfigFolder}/${featureName}_system.conf`;
    const dnsmasqEntry = `mac-address-tag=%FF:FF:FF:FF:FF:FF$${featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async systemStop() {
    const configFile = `${dnsmasqConfigFolder}/${featureName}_system.conf`;
    const dnsmasqEntry = `mac-address-tag=%FF:FF:FF:FF:FF:FF$!${featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perTagStart(tagUid) {
    const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
    const dnsmasqEntry = `group-tag=@${tagUid}$${featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perTagStop(tagUid) {
    const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
    const dnsmasqEntry = `group-tag=@${tagUid}$!${featureName}\n`; // match negative tag
    await fs.writeFileAsync(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perTagReset(tagUid) {
    const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
    await fs.unlinkAsync(configFile).catch((err) => { });
    dnsmasq.scheduleRestartDNSService();
  }

  async perNetworkStart(uuid) {
    const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
    if (!networkProfile) {
      log.warn(`Network profile is not found on ${uuid}`);
      return;
    }
    const configFile = `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${featureName}_${uuid}.conf`;
    const dnsmasqEntry = `mac-address-tag=%00:00:00:00:00:00$${featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perNetworkStop(uuid) {
    const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
    if (!networkProfile) {
      log.warn(`Network profile is not found on ${uuid}`);
      return;
    }
    const configFile = `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${featureName}_${uuid}.conf`;
    // explicit disable family protect
    const dnsmasqEntry = `mac-address-tag=%00:00:00:00:00:00$!${featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perNetworkReset(uuid) {
    const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
    if (!networkProfile) {
      log.warn(`Network profile is not found on ${uuid}`);
      return;
    }
    const configFile = `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${featureName}_${uuid}.conf`;
    // remove config file
    await fs.unlinkAsync(configFile).catch((err) => { });
    dnsmasq.scheduleRestartDNSService();
  }

  async perDeviceStart(macAddress) {
    const configFile = `${dnsmasqConfigFolder}/${featureName}_${macAddress}.conf`;
    const dnsmasqentry = `mac-address-tag=%${macAddress.toUpperCase()}$${featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqentry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perDeviceStop(macAddress) {
    const configFile = `${dnsmasqConfigFolder}/${featureName}_${macAddress}.conf`;
    const dnsmasqentry = `mac-address-tag=%${macAddress.toUpperCase()}$!${featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqentry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perDeviceReset(macAddress) {
    const configFile = `${dnsmasqConfigFolder}/${featureName}_${macAddress}.conf`;
    // remove config file
    await fs.unlinkAsync(configFile).catch((err) => { });
    dnsmasq.scheduleRestartDNSService();
  }

  async perIdentityStart(guid) {
    const identity = IdentityManager.getIdentityByGUID(guid);
    if (identity) {
      const uid = identity.getUniqueId();
      const configFile = `${dnsmasqConfigFolder}/${identity.constructor.getDnsmasqConfigFilenamePrefix(uid)}_${featureName}.conf`;
      const dnsmasqEntry = `group-tag=@${identity.constructor.getEnforcementDnsmasqGroupId(uid)}$${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
    }
  }

  async perIdentityStop(guid) {
    const identity = IdentityManager.getIdentityByGUID(guid);
    if (identity) {
      const uid = identity.getUniqueId();
      const configFile = `${dnsmasqConfigFolder}/${identity.constructor.getDnsmasqConfigFilenamePrefix(uid)}_${featureName}.conf`;
      const dnsmasqEntry = `group-tag=@${identity.constructor.getEnforcementDnsmasqGroupId(uid)}$!${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
    }
  }

  async perIdentityReset(guid) {
    const identity = IdentityManager.getIdentityByGUID(guid);
    if (identity) {
      const uid = identity.getUniqueId();
      const configFile = `${dnsmasqConfigFolder}/${identity.constructor.getDnsmasqConfigFilenamePrefix(uid)}_${featureName}.conf`;
      await fs.unlinkAsync(configFile).catch((err) => { });
      dnsmasq.scheduleRestartDNSService();
    }
  }

  // global on/off
  async globalOn() {
    this.adminSystemSwitch = true;
    await this.applyDoH();
  }

  async globalOff() {
    this.adminSystemSwitch = false;
    await this.applyDoH();
  }
}

module.exports = DNSCryptPlugin;
