import { SmartDrop } from "../device";
import { PropertyName } from "../types";
import { CommandType } from "../../p2p";

// Payloads as logged live on 2026-09-22/23 (T8790 on HomeBase 2).
describe("SmartDrop.classifyOpen", () => {
  test("master PIN", () => {
    expect(SmartDrop.classifyOpen({ openType: 2, userIndex: 0 }, { openType: 2, pin: "0" })).toMatchObject({ type: 2, name: "", userIndex: 0 });
  });
  test("master PIN, push only", () => {
    expect(SmartDrop.classifyOpen(undefined, { openType: 2, pin: "0" })).toMatchObject({ type: 2 });
  });
  test("delivery PIN resolves the carrier name from the push", () => {
    expect(SmartDrop.classifyOpen({ openType: 2, userIndex: 47828 }, { openType: 2, pin: "47828", personName: "Amazon" })).toMatchObject({ type: 3, name: "Amazon", userIndex: 47828 });
  });
  test("delivery PIN, P2P only, falls back to the slot", () => {
    expect(SmartDrop.classifyOpen({ openType: 2, userIndex: 38505 }, undefined)).toMatchObject({ type: 3, name: "38505" });
  });
  test("carrier openType 3", () => {
    expect(SmartDrop.classifyOpen({ openType: 3 }, { openType: 3, pin: "0" })).toMatchObject({ type: 4, name: "Unknown" });
  });
  test("OPEN button (openType 240, userIndex 0) is a carrier, not a master PIN", () => {
    expect(SmartDrop.classifyOpen({ openType: 240, userIndex: 0 }, { openType: 240, pin: "0" })).toMatchObject({ type: 4, name: "Unknown", rawOpenType: 240 });
    expect(SmartDrop.classifyOpen(undefined, { openType: 240, pin: "0" })).toMatchObject({ type: 4 });
  });
  test("PIN-type open without a slot is a press-open carrier drop", () => {
    expect(SmartDrop.classifyOpen({ openType: 2 }, { openType: 2, pin: "0" })).toMatchObject({ type: 4, name: "Unknown" });
  });
  test("app", () => {
    expect(SmartDrop.classifyOpen(undefined, { openType: 1 })).toMatchObject({ type: 1 });
  });
});

/** A SmartDrop with just enough state to drive the open aggregation (no API / station). */
const fakeSmartDrop = () => {
  const drop = Object.create(SmartDrop.prototype);
  const props: Record<string, unknown> = { [PropertyName.DeviceTimesOpened]: 0 };
  const changes: Array<[string, unknown]> = [];
  const events: unknown[] = [];
  drop.eventTimeouts = new Map();
  drop.eventDurationSeconds = 10;
  drop.getSerial = () => "T8790TEST";
  drop.getPropertyValue = (name: string) => props[name];
  drop.updateProperty = (name: string, value: unknown, force = false) => {
    if (props[name] === value && !force) return false;
    props[name] = value;
    changes.push([name, value]);
    if (name === PropertyName.DevicePackageDelivered && value === false) drop.updateProperty(PropertyName.DeviceTimesOpened, 0);
    return true;
  };
  drop.updateRawProperty = (type: number, value: string) => {
    if (type === CommandType.CMD_SMART_DROP_OPEN) return drop.updateProperty(PropertyName.DeviceOpen, value === "1");
    if (type === CommandType.SUB1G_REP_SMARTDROP_DELIVERY_COUNT) return drop.updateProperty(PropertyName.DeviceDeliveries, Number(value));
    return false;
  };
  drop.emit = (name: string, _device: unknown, details: unknown) => {
    events.push({ name, details });
    return true;
  };
  return { drop, props, changes, events };
};

describe("SmartDrop open aggregation", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("P2P then push resolve once, with the name and without a slot-number flash", () => {
    const { drop, props, changes, events } = fakeSmartDrop();
    drop.p2pOpenEvent(1, 2, 47828);
    expect(props[PropertyName.DeviceOpen]).toBe(true);
    expect(events).toHaveLength(0);
    drop.addOpenSignal({ push: { openType: 2, pin: "47828", personName: "Amazon" } }, "push");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: "smartdrop opened", details: { openedByType: 3, openedByName: "Amazon", userIndex: 47828, timesOpened: 1 } });
    expect(changes.filter(([n]) => n === PropertyName.DeviceLastOpenedByName).map(([, v]) => v)).toEqual(["Amazon"]);
    expect(props[PropertyName.DevicePackageDelivered]).toBe(true);
  });

  test("master PIN never bumps timesOpened before resetting it", () => {
    const { drop, props, changes } = fakeSmartDrop();
    props[PropertyName.DeviceTimesOpened] = 0;
    drop.p2pOpenEvent(1, 2, 0);
    drop.addOpenSignal({ push: { openType: 2, pin: "0" } }, "push");
    expect(changes.filter(([n]) => n === PropertyName.DeviceTimesOpened).map(([, v]) => v)).not.toContain(1);
    expect(props[PropertyName.DeviceLastOpenedByType]).toBe(2);
    expect(props[PropertyName.DevicePackageDelivered]).toBe(false);
  });

  test("OPEN button after a master PIN reports Carrier and counts a delivery", () => {
    const { drop, props, events } = fakeSmartDrop();
    props[PropertyName.DeviceLastOpenedByType] = 2;
    drop.p2pOpenEvent(1, 240, 0);
    drop.addOpenSignal({ push: { openType: 240, pin: "0" } }, "push");
    expect(props[PropertyName.DeviceLastOpenedByType]).toBe(4);
    expect(props[PropertyName.DeviceLastOpenedByName]).toBe("Unknown");
    expect(props[PropertyName.DeviceTimesOpened]).toBe(1);
    expect(props[PropertyName.DevicePackageDelivered]).toBe(true);
    expect(events).toHaveLength(1);
  });

  test("missing push resolves on timeout; a late push fills the name without re-counting", () => {
    const { drop, props, events } = fakeSmartDrop();
    drop.p2pOpenEvent(1, 3, undefined);
    jest.advanceTimersByTime(SmartDrop.OPEN_RESOLVE_TIMEOUT_MS);
    expect(events).toHaveLength(1);
    expect(props[PropertyName.DeviceLastOpenedByName]).toBe("Unknown");
    drop.addOpenSignal({ push: { openType: 3, pin: "0", personName: "UPS" } }, "push");
    expect(events).toHaveLength(1);
    expect(props[PropertyName.DeviceTimesOpened]).toBe(1);
    expect(props[PropertyName.DeviceLastOpenedByName]).toBe("UPS");
  });

  test("close clears the latched left-open alert", () => {
    const { drop, props } = fakeSmartDrop();
    drop.p2pOpenEvent(1, 3, undefined);
    props[PropertyName.DeviceLidStuckAlert] = true;
    drop.p2pOpenEvent(2, 0, undefined);
    expect(props[PropertyName.DeviceOpen]).toBe(false);
    expect(props[PropertyName.DeviceLidStuckAlert]).toBe(false);
  });
});
