# Tuya F3 Pro UK Date Patcher

This tool recreates the **tested UK date-format modification** for one known Tuya F3 Pro firmware build.

It changes the display from:

```text
09/11 Fri.
```

to:

```text
Fri 11/09
```

The modification was successfully boot-tested on the original device on **12 September 2026**.

## What is included

- `patch_f3pro_uk_date.py` — validates, unpacks, patches, rebuilds and verifies the firmware.
- `README.md` — usage and technical notes.

No original or modified vendor firmware is distributed. Each user must dump the firmware from their own device.

## Supported input

The script intentionally accepts only this exact known-good build:

```text
Size:    8,388,608 bytes (0x800000)
SHA-256: 9036d1fefd13ad612360a5c098fc24d5269ad6debe898ad9b17aeeea05632967
```

It refuses unknown images rather than applying offsets speculatively.

## Requirements

- Linux
- Python 3.9 or newer
- A compatible Melis `minfs` command-line utility
- `sunxi-fel` for dumping and subsequently flashing the device

The `minfs` utility from the open-source
[`melis-utils`](https://github.com/usr-sse2/melis-utils) project can be built
separately. Pass its location with `--minfs`; it is not bundled here.

## Create the update

Keep the verified original dump read-only:

```bash
chmod a-w tuya_f3_pro_original.bin
```

Run the patcher:

```bash
python3 patch_f3pro_uk_date.py \
  tuya_f3_pro_original.bin \
  tuya_f3_pro_uk_date.bin \
  --minfs /path/to/minfs
```

The script performs all of the following:

1. Requires an input size of exactly `0x800000` bytes.
2. Requires the known original SHA-256.
3. Extracts the MinFS region at `0x02A000`.
4. Locates `apps/leopard.axf`.
5. Changes all seven weekday format strings.
6. Swaps the month/day data pointers.
7. Rebuilds the fixed-size MinFS.
8. Extracts the rebuilt MinFS again and verifies the patch survived compression.
9. Confirms the boot area and persistent FAT/configuration regions were not changed.
10. Writes a new complete 8 MiB flash image and prints its SHA-256.

For this exact toolchain, the previously tested output had:

```text
SHA-256: 4dd0f94097904134454ecf4270ac0908c41d0482d326f9073cada5f518dbe547
```

Different compatible `minfs` builds may produce different compressed bytes, so the output hash can differ even when the extracted files are equivalent. The script therefore verifies the rebuilt application itself rather than requiring that output hash.

## Flashing

Enter FEL mode using the documented reset-to-ground sequence, then take one final backup:

```bash
sudo sunxi-fel -v -p spiflash-read 0 0x800000 before_update.bin
sha256sum before_update.bin
```

Write the generated image:

```bash
sudo sunxi-fel -v -p spiflash-write 0 tuya_f3_pro_uk_date.bin
```

Before booting, read it back and compare:

```bash
sudo sunxi-fel -v -p spiflash-read 0 0x800000 after_update.bin
sha256sum tuya_f3_pro_uk_date.bin after_update.bin
cmp tuya_f3_pro_uk_date.bin after_update.bin
```

Both hashes must agree and `cmp` must produce no output.

## Recovery

If the panel fails to boot, re-enter FEL mode and restore the verified original:

```bash
sudo sunxi-fel -v -p spiflash-write 0 before_update.bin
```

Do not connect the programming interface while the panel is connected to mains.

## Technical implementation

The primary application is `apps/leopard.axf`, an ARM32 EABI5 Melis/ePDK module reconstructed as ELF during extraction.

The original application contains seven weekday-specific format strings:

```text
%02d/%02d Sun.
%02d/%02d Mon.
%02d/%02d Tues.
%02d/%02d Wed.
%02d/%02d Thur.
%02d/%02d Fri.
%02d/%02d Sat.
```

They are replaced in their existing fixed-size slots with weekday-first strings. Two literal-pool pointers used to supply the numeric date fields are swapped to change month/day into day/month. No executable section is enlarged and no partitions are moved.

## Sharing and copyright

Share this patcher and documentation, not full firmware dumps, rebuilt images, extracted vendor executables, fonts, graphics or media. The script is designed to operate on a firmware image legally obtained by the device owner.

## Status

- Hardware boot test: **passed**
- UK weekday-first display: **passed**
- Full 8 MiB output size: **passed**
- Read/rebuild/re-extract verification: **passed**
- Other proposed changes (scene removal, one curtain, button/relay decoupling): **not included**
