# Tuya F3 Pro radar converter patch

This package adds a read-only Zigbee2MQTT `occupancy` property derived from
Tuya datapoint 149 while retaining the converter's existing writable
`backlight_switch` property.

Firmware analysis shows that the panel reports:

- DP 149 Boolean `1`: radar wake-up / presence
- DP 149 Boolean `0`: radar idle / no presence

Because the panel links radar state and display wake state, `occupancy` remains
true until the panel enters its radar-idle state.

## Install the complete converter

Copy `tuya_f3pro_touchpanel_converter.js` into the Zigbee2MQTT external
converters directory, replacing the earlier version. Restart Zigbee2MQTT and
reconfigure or re-interview the device so Home Assistant discovers the new
occupancy entity.

## Apply only the Git patch

From the root of the repository:

```bash
git apply --check f3pro_radar_dp149.patch
git apply f3pro_radar_dp149.patch
```

The patch was generated from commit:

```text
d19ba456f907761979d1b7c66800457a2d78fa26
```

Suggested commit message:

```text
feat(converter): expose F3-Pro radar presence from DP 149
```
