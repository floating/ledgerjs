//@flow
import Transport from "@ledgerhq/hw-transport";
import type {
  Observer,
  DescriptorEvent,
  Subscription
} from "@ledgerhq/hw-transport";
import hidFraming from "@ledgerhq/devices/lib/hid-framing";
import { identifyUSBProductId } from "@ledgerhq/devices";
import type { DeviceModel } from "@ledgerhq/devices";
import {
  TransportOpenUserCancelled,
  TransportInterfaceNotAvailable,
  DisconnectedDeviceDuringOperation,
  DisconnectedDevice
} from "@ledgerhq/errors";
import {
  getLedgerDevices,
  getFirstLedgerDevice,
  requestLedgerDevice,
  isSupported
} from "./webusb";

const configurationValue = 1;
const interfaceNumber = 2;
const endpointNumber = 3;

/**
 * WebUSB Transport implementation
 * @example
 * import TransportWebUSB from "@ledgerhq/hw-transport-webusb";
 * ...
 * TransportWebUSB.create().then(transport => ...)
 */
export default class TransportWebUSB extends Transport<USBDevice> {
  device: USBDevice;
  deviceModel: ?DeviceModel;
  channel = Math.floor(Math.random() * 0xffff);
  packetSize = 64;

  constructor(device: USBDevice) {
    super();
    this.device = device;
    this.deviceModel = identifyUSBProductId(device.productId);
  }

  /**
   * Check if WebUSB transport is supported.
   */
  static isSupported = isSupported;

  /**
   * List the WebUSB devices that was previously authorized by the user.
   */
  static list = getLedgerDevices;

  /**
   * Actively listen to WebUSB devices and emit ONE device
   * that was either accepted before, if not it will trigger the native permission UI.
   *
   * Important: it must be called in the context of a UI click!
   */
  static listen = (
    observer: Observer<DescriptorEvent<USBDevice>>
  ): Subscription => {
    let unsubscribed = false;
    getFirstLedgerDevice().then(
      device => {
        if (!unsubscribed) {
          const deviceModel = identifyUSBProductId(device.productId);
          observer.next({ type: "add", descriptor: device, deviceModel });
          observer.complete();
        }
      },
      error => {
        observer.error(new TransportOpenUserCancelled(error.message));
      }
    );
    function unsubscribe() {
      unsubscribed = true;
    }
    return { unsubscribe };
  };

  /**
   * Similar to create() except it will always display the device permission (even if some devices are already accepted).
   */
  static async request() {
    const device = await requestLedgerDevice();
    return TransportWebUSB.open(device);
  }

  /**
   * Similar to create() except it will never display the device permission (it returns a Promise<?Transport>, null if it fails to find a device).
   */
  static async openConnected() {
    const devices = await getLedgerDevices();
    if (devices.length === 0) return null;
    return TransportWebUSB.open(devices[0]);
  }

  /**
   * Create a Ledger transport with a USBDevice
   */
  static async open(device: USBDevice) {
    await device.open();
    if (device.configuration === null) {
      await device.selectConfiguration(configurationValue);
    }
    await device.reset();
    try {
      await device.claimInterface(interfaceNumber);
    } catch (e) {
      await device.close();
      throw new TransportInterfaceNotAvailable(e.message);
    }
    const transport = new TransportWebUSB(device);
    const onDisconnect = e => {
      if (device === e.device) {
        // $FlowFixMe
        navigator.usb.removeEventListener("disconnect", onDisconnect);
        transport._emitDisconnect(new DisconnectedDevice());
      }
    };
    // $FlowFixMe
    navigator.usb.addEventListener("disconnect", onDisconnect);
    return transport;
  }

  _disconnectEmitted = false;
  _emitDisconnect = (e: Error) => {
    if (this._disconnectEmitted) return;
    this._disconnectEmitted = true;
    this.emit("disconnect", e);
  };

  /**
   * Release the transport device
   */
  async close(): Promise<void> {
    await this.exchangeBusyPromise;
    await this.device.releaseInterface(interfaceNumber);
    await this.device.reset();
    await this.device.close();
  }

  /**
   * Exchange with the device using APDU protocol.
   * @param apdu
   * @returns a promise of apdu response
   */
  exchange = (apdu: Buffer): Promise<Buffer> =>
    this.exchangeAtomicImpl(async () => {
      const { debug, channel, packetSize } = this;
      if (debug) {
        debug("=>" + apdu.toString("hex"));
      }

      const framing = hidFraming(channel, packetSize);

      // Write...
      const blocks = framing.makeBlocks(apdu);
      for (let i = 0; i < blocks.length; i++) {
        await this.device.transferOut(endpointNumber, blocks[i]);
      }

      // Read...
      let result;
      let acc;
      while (!(result = framing.getReducedResult(acc))) {
        const r = await this.device.transferIn(endpointNumber, packetSize);
        acc = framing.reduceResponse(acc, Buffer.from(r.data.buffer));
      }

      if (debug) {
        debug("<=" + result.toString("hex"));
      }
      return result;
    }).catch(e => {
      if (e && e.message && e.message.includes("disconnected")) {
        this._emitDisconnect(e);
        throw new DisconnectedDeviceDuringOperation(e.message);
      }
      throw e;
    });

  setScrambleKey() {}
}
