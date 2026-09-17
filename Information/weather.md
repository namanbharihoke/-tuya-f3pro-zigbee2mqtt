# Tuya F3 Pro — Weather Status Control

This note documents how to update the weather shown on the Tuya F3 Pro through Zigbee2MQTT, along with the protocol details recovered from the firmware.

## Quick start

Replace the MQTT broker address and Zigbee2MQTT device name if yours differ:

```bash
mosquitto_pub \
  -h YOUR_MQTT_BROKER \
  -t 'zigbee2mqtt/MasterBedroom Intelligence Switch/set' \
  -m '{"temperature_1":18,"condition_1":"cloudy"}'
```

Send `temperature_1` and `condition_1` together. This gives Zigbee2MQTT enough state to construct the complete Tuya weather-sync message.

More examples:

```bash
# Sunny, 19 °C
mosquitto_pub -h YOUR_MQTT_BROKER \
  -t 'zigbee2mqtt/MasterBedroom Intelligence Switch/set' \
  -m '{"temperature_1":19,"condition_1":"sunny"}'

# Cloudy, 14 °C
mosquitto_pub -h YOUR_MQTT_BROKER \
  -t 'zigbee2mqtt/MasterBedroom Intelligence Switch/set' \
  -m '{"temperature_1":14,"condition_1":"cloudy"}'

# Light rain, 11 °C
mosquitto_pub -h YOUR_MQTT_BROKER \
  -t 'zigbee2mqtt/MasterBedroom Intelligence Switch/set' \
  -m '{"temperature_1":11,"condition_1":"light_rain"}'
```

For predictable display behaviour, use a whole-number Celsius temperature. The exposed range is **-65 to 99 °C**.

## Supported weather conditions

The text in the left column is the value accepted by Zigbee2MQTT. The numeric value is the byte placed in the Tuya weather payload.

| Zigbee2MQTT value | Code | Hex |
|---|---:|---:|
| `heavy_rain` | 101 | `0x65` |
| `thunderstorm` | 102 | `0x66` |
| `dust_storm` | 103 | `0x67` |
| `light_snow` | 104 | `0x68` |
| `snow` | 105 | `0x69` |
| `freezing_fog` | 106 | `0x6A` |
| `shower` | 108 | `0x6C` |
| `floating_dust` | 109 | `0x6D` |
| `thunder_and_lighting` | 110 | `0x6E` |
| `light_shower` | 111 | `0x6F` |
| `rain` | 112 | `0x70` |
| `rain_and_snow` | 113 | `0x71` |
| `dust_bowl` | 114 | `0x72` |
| `ice_pellets` | 115 | `0x73` |
| `strong_dust_storms` | 116 | `0x74` |
| `sandy` | 117 | `0x75` |
| `light_to_moderate_rain` | 118 | `0x76` |
| `mostly_sunny` | 119 | `0x77` |
| `sunny` | 120 | `0x78` |
| `haze` | 121 | `0x79` |
| `heavy_shower` | 123 | `0x7B` |
| `heavy_snow` | 124 | `0x7C` |
| `very_heavy_rain` | 125 | `0x7D` |
| `blizzard` | 126 | `0x7E` |
| `ice_pod` | 127 | `0x7F` |
| `light_to_moderate_snow` | 128 | `0x80` |
| `few_clouds` | 129 | `0x81` |
| `light_snow_showers` | 130 | `0x82` |
| `moderate_snow` | 131 | `0x83` |
| `cloudy` | 132 | `0x84` |
| `icy_needles` | 133 | `0x85` |
| `thunderstorm_with_ice_pods` | 136 | `0x88` |
| `freezing_rain` | 137 | `0x89` |
| `snow_shower` | 138 | `0x8A` |
| `light_rain` | 139 | `0x8B` |
| `thunder` | 140 | `0x8C` |
| `moderate_rain` | 141 | `0x8D` |
| `moderate_to_heavy_rain` | 144 | `0x90` |

The unusual spellings such as `thunder_and_lighting`, `ice_pod`, and `ice_pods` are intentional: they match the current Zigbee2MQTT converter and must be sent exactly as shown.

## Home Assistant action

```yaml
action:
  - action: mqtt.publish
    data:
      topic: "zigbee2mqtt/MasterBedroom Intelligence Switch/set"
      payload: >-
        {"temperature_1": 14, "condition_1": "cloudy"}
```

The values can also be templated from a weather entity. A suggested Home Assistant-to-F3 mapping is:

| Home Assistant condition | Suggested F3 condition |
|---|---|
| `clear-night` | `sunny` or `mostly_sunny` |
| `sunny` | `sunny` |
| `partlycloudy` | `few_clouds` |
| `cloudy` | `cloudy` |
| `rainy` | `rain` |
| `pouring` | `heavy_rain` |
| `snowy` | `snow` |
| `snowy-rainy` | `rain_and_snow` |
| `lightning` | `thunder` |
| `lightning-rainy` | `thunder_and_lighting` |
| `fog` | `haze`, or `freezing_fog` below freezing |

This provider mapping is a practical suggestion, not a Tuya-defined canonical mapping.

## Node-RED

Send a JSON object from a Function node to an MQTT Out node:

```javascript
msg.topic = "zigbee2mqtt/MasterBedroom Intelligence Switch/set";
msg.payload = {
    temperature_1: 14,
    condition_1: "cloudy"
};
return msg;
```

Configure the MQTT Out node to use `msg.topic` and connect it to the same broker used by Zigbee2MQTT.

## Checking whether the update was sent

Monitor the device and Zigbee2MQTT logs while publishing a test update:

```bash
mosquitto_sub \
  -h YOUR_MQTT_BROKER \
  -v \
  -t 'zigbee2mqtt/MasterBedroom Intelligence Switch/#' \
  -t 'zigbee2mqtt/bridge/logging'
```

If the friendly name differs, find it in the Zigbee2MQTT frontend and substitute it verbatim in both the publish and subscribe topics.

## What Zigbee2MQTT sends

This is not handled as a normal user-facing Tuya datapoint write. Zigbee2MQTT's F3-Pro definition uses the manufacturer-specific Tuya cluster and sends the `tuyaWeatherSync` command.

The converter builds a payload containing:

- a small weather-sync header;
- the number of forecast days;
- whether current weather is included;
- temperature as a signed 16-bit big-endian value;
- humidity, when supplied, as a signed 16-bit big-endian value;
- the weather condition as a single byte.

The weather field identifiers used by the converter are:

| Field | ID |
|---|---:|
| Temperature | `0x01` |
| Humidity | `0x02` |
| Condition | `0x03` |

For the example `18 °C` and `cloudy`, the significant field values are:

```text
Temperature: 00 12
Condition:   84
```

Do not send those bytes directly unless you are deliberately implementing the complete Tuya manufacturer-cluster command. Zigbee2MQTT already adds the required framing and header.

## Findings from the F3-Pro firmware

Analysis of the extracted `leopard.axf` application confirms the other end of this path:

- weather-condition strings are present in the firmware;
- a command dispatcher compares the incoming command with **`0x3B`** at virtual address **`0xE920E46C`**;
- this identifies `0x3B` as the panel-side Tuya UART weather-sync command;
- the firmware accepts the same weather-condition code family beginning at `0x65` (decimal 101);
- the received condition is mapped to the panel's built-in weather text/icon resources.

The resulting path is therefore:

```text
MQTT set message
    -> Zigbee2MQTT F3-Pro converter
    -> Tuya manufacturer-specific Zigbee command: tuyaWeatherSync
    -> Tuya/Zigbee module
    -> panel UART command 0x3B
    -> Melis application and weather display
```

This means the safest and easiest integration point is the ordinary Zigbee2MQTT `/set` topic. Patching the firmware is not required merely to change the displayed weather.

## Troubleshooting

1. Confirm that Zigbee2MQTT recognises the device as an F3 Pro and exposes `temperature_1` and `condition_1`.
2. Ensure the MQTT topic uses the exact Zigbee2MQTT friendly name.
3. Send temperature and condition in one JSON object.
4. Use a condition name exactly as listed above.
5. Start with an integer Celsius temperature.
6. Watch `zigbee2mqtt/bridge/logging` for validation or delivery errors.
7. If the MQTT state changes but the panel does not, wake or rejoin the device and retry while monitoring Zigbee2MQTT logs.

## References

- [Zigbee2MQTT: Tuya F3 Pro device page](https://www.zigbee2mqtt.io/devices/F3_Pro.html)
- [zigbee-herdsman-converters: Tuya device definitions](https://github.com/Koenkk/zigbee-herdsman-converters/blob/master/src/devices/tuya.ts)
- [zigbee-herdsman-converters: Tuya weather converter implementation](https://github.com/Koenkk/zigbee-herdsman-converters/blob/master/src/lib/tuya.ts)

## Firmware note

Keep an untouched, verified SPI dump before making any firmware changes. The weather update described here is runtime communication only and does not modify the flash image.
