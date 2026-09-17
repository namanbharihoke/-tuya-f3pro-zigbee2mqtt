# Tuya F3 Pro: Hardware Access, FEL Mode and SPI Flash Dumping

This note documents the **working hardware method** for placing the Tuya F3 Pro into Allwinner FEL/SPI access mode and taking a complete backup of its SPI flash.

## Safety first

> **Disconnect the panel completely from mains power before opening it or connecting test equipment.**

The low-voltage programming interface must not be connected to a PC, programmer or USB adapter while the panel remains connected to mains. Power the low-voltage board only through the known USB/programming arrangement.

- Avoid powering the board simultaneously from USB and the panel's normal supply; this may back-feed either source.
- Point 4 is a **5 V supply point**. Do not assume the two data points or the SoC itself are 5 V logic tolerant.
- Confirm ground before connecting power.
- Avoid shorts around the nearby solder pads.
- Preserve an untouched, verified dump before attempting any write or erase operation.

## Programming points

On the device there are five solder points and two jumpers. Using the numbering established during testing:

```text
1  2  3  4
5
```

| Point | Function | Notes |
|---:|---|---|
| 1 | Ground | Common ground for the USB/programming connection |
| 2 | USB data | One side of the USB data pair |
| 3 | USB data | Other side of the USB data pair |
| 4 | 5 V | USB/programming supply |
| 5 | Reset (`RST`) | Pull to ground during power-up to enter the required boot mode NOTE THIS NEEDS TO BE A SHORT CABLE LONG CABLES LEAD TO ERROR | 

The numbering above is specific to the observed board orientation. Photograph and label the board before attaching wires, because the physical connector has no keyed plug to prevent reversal.

## Entering FEL mode

1. Disconnect the device from mains and any other power source.
2. Connect ground, the USB data pair and 5 V to the programming interface.
3. Connect point **5 (`RST`) to ground**.
4. Start watching kernel messages on the Linux host:

   ```bash
   sudo dmesg -w
   ```

5. Power/connect the USB interface while keeping `RST` grounded.
6. Wait for a message similar to:

   ```text
   new high-speed USB device number XX using xhci_hcd
   ```

7. **Release `RST` from ground as soon as that USB-enumeration message appears.** Do not leave reset permanently grounded.
8. Confirm that the SoC is visible to `sunxi-fel`:

   ```bash
   sunxi-fel ver
   ```

If `sunxi-fel ver` cannot see the device, disconnect power and repeat the entry sequence rather than moving on to flash operations.

## Dumping the complete SPI flash

The fitted SPI flash is **8 MiB**, so a complete read is `0x800000` bytes:

```bash
sunxi-fel spiflash-read 0 0x800000 tuya_f3_pro_dump_01.bin
sunxi-fel spiflash-read 0 0x800000 tuya_f3_pro_dump_02.bin
sunxi-fel spiflash-read 0 0x800000 tuya_f3_pro_dump_03.bin
```

Check that every output is exactly **8,388,608 bytes**:

```bash
stat -c '%n  %s bytes' tuya_f3_pro_dump_*.bin
```

## Validating a clean read

Take at least three independent reads and compare their hashes:

```bash
sha256sum tuya_f3_pro_dump_*.bin
```

All three SHA-256 values should be identical. `md5sum` is also sufficient for detecting an accidental read difference, but SHA-256 is preferable for recording the long-term identity of the backup:

```bash
md5sum tuya_f3_pro_dump_*.bin
```

For a direct byte-for-byte comparison:

```bash
cmp tuya_f3_pro_dump_01.bin tuya_f3_pro_dump_02.bin
cmp tuya_f3_pro_dump_01.bin tuya_f3_pro_dump_03.bin
```

Successful `cmp` commands produce no output. If even one read differs, do **not** choose whichever dump merely looks most plausible. Check the wiring, reset timing and power stability, then repeat the reads until multiple complete dumps match exactly.

## Known-good dump reference

The clean dump analysed during this project has:

```text
Size:    8,388,608 bytes (0x800000)
SHA-256: 9036d1fefd13ad612360a5c098fc24d5269ad6debe898ad9b17aeeea05632967
```

An earlier capture with SHA-256
`2cbaa659beae5f424a351b0b81bc3132ffd8c5d128246c94fb75a272a2fc1224`
was the same nominal size but differed extensively and should **not** be used as the golden recovery image.

Keep the verified original read-only and perform all unpacking or modifications on copies:

```bash
cp tuya_f3_pro_dump_01.bin tuya_f3_pro_working_copy.bin
chmod a-w tuya_f3_pro_dump_01.bin
```

Store another copy away from the machine used for flashing.

## Confirmed firmware layout

The clean 8 MiB image is complete and contains the expected boot, application and persistent-data regions:

| Flash offset | Size | Contents |
|---:|---:|---|
| `0x000000` | — | Allwinner boot area, including boot0 and boot1 |
| `0x02A000` | `0x7B2000` | Melis MinFS root filesystem |
| `0x7DC000` | `0x11000` | First FAT/UDISK configuration copy |
| `0x7EE000` | `0x11000` | Second FAT/UDISK configuration copy |
| `0x7FF000` | `0x1000` | Final flash-tail sector |

The principal application is `apps/leopard.axf`. It is **32-bit ARM EABI5**, not RISC-V. The image runs the older Allwinner Melis/ePDK and Willow software stack.

## Before writing modified firmware

Reading is relatively safe; writing is where recovery risk begins.

- Never write until a known-good 8 MiB dump has been verified several times.
- Patch a copy, never the only original.
- Confirm that the generated image remains exactly `0x800000` bytes.
- Prefer staged changes so that one behavioural modification can be tested at a time.
- Do not interrupt power during a flash write.
- After writing, read the flash back into a new file and compare it with the intended image before attempting a normal boot.
- Keep the solder points accessible until the modified image has booted and been tested.

The recovery path is the same FEL/SPI interface: re-enter FEL mode and restore the complete known-good 8 MiB image if a modified build fails to boot.

