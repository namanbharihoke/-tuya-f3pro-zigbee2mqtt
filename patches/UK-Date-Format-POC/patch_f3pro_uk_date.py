#!/usr/bin/env python3
"""Build the tested UK-date Tuya F3 Pro firmware from an owner's clean dump.

This program contains no vendor firmware. It requires the user to provide both
their original dump and a compatible `minfs` utility.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path


FLASH_SIZE = 0x800000
ROOTFS_OFFSET = 0x02A000
ROOTFS_SIZE = 0x7B2000
SUPPORTED_SHA256 = "9036d1fefd13ad612360a5c098fc24d5269ad6debe898ad9b17aeeea05632967"

ELF_BASE_VA = 0xE9200000
ELF_BASE_FILE_OFFSET = 0x16C

DATE_REPLACEMENTS = {
    0x5DFDCD: (b"%02d/%02d Sun.\0", b"Sun %02d/%02d\0"),
    0x5DFDDC: (b"%02d/%02d Mon.\0", b"Mon %02d/%02d\0"),
    0x5DFDEB: (b"%02d/%02d Tues.\0", b"Tue %02d/%02d\0"),
    0x5DFDFB: (b"%02d/%02d Wed.\0", b"Wed %02d/%02d\0"),
    0x5DFE0A: (b"%02d/%02d Thur.\0", b"Thu %02d/%02d\0"),
    0x5DFE1A: (b"%02d/%02d Fri.\0", b"Fri %02d/%02d\0"),
    0x5DFE29: (b"%02d/%02d Sat.\0", b"Sat %02d/%02d\0"),
}


class PatchError(RuntimeError):
    pass


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run(command: list[str]) -> None:
    shown = " ".join(command)
    print(f"+ {shown}")
    result = subprocess.run(
        command,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
    )
    if result.returncode:
        if result.stdout:
            print(result.stdout, file=sys.stderr)
        raise PatchError(f"command failed with exit code {result.returncode}: {shown}")


def replace_fixed_slot(data: bytearray, offset: int, old: bytes, new: bytes) -> None:
    if len(new) > len(old):
        raise PatchError(f"replacement does not fit at file offset {offset:#x}")
    actual = bytes(data[offset : offset + len(old)])
    if actual != old:
        raise PatchError(
            f"unexpected leopard.axf bytes at {offset:#x}; "
            "this is not the supported application build"
        )
    data[offset : offset + len(old)] = new + b"\0" * (len(old) - len(new))


def va_to_file_offset(address: int) -> int:
    return ELF_BASE_FILE_OFFSET + address - ELF_BASE_VA


def patch_leopard(path: Path) -> None:
    data = bytearray(path.read_bytes())

    # Some upstream variants of the Melis MinFS dumper incorrectly label this
    # reconstructed wrapper as RISC-V. The executable payload is ARM EABI5.
    if data[:4] != b"\x7fELF" or data[4] != 1 or data[5] != 1:
        raise PatchError("apps/leopard.axf is not the expected ELF32 little-endian file")
    struct.pack_into("<H", data, 0x12, 40)          # EM_ARM
    struct.pack_into("<I", data, 0x24, 0x05000000)  # EABI version 5

    for offset, (old, new) in DATE_REPLACEMENTS.items():
        replace_fixed_slot(data, offset, old, new)

    # Swap the globals supplied as the two numeric sprintf arguments: M/D -> D/M.
    first = va_to_file_offset(0xE9204530)
    second = va_to_file_offset(0xE9204534)
    pointers = struct.unpack_from("<II", data, first)
    if pointers != (0xE99C019C, 0xE99C0198):
        raise PatchError(f"unexpected date pointers: {pointers!r}")
    struct.pack_into("<II", data, first, pointers[1], pointers[0])

    path.write_bytes(data)


def verify_patched_leopard(path: Path) -> None:
    data = path.read_bytes()
    for _offset, (_old, new) in DATE_REPLACEMENTS.items():
        if data.count(new.rstrip(b"\0")) != 1:
            raise PatchError(f"rebuilt application does not contain exactly one {new!r}")
    first = va_to_file_offset(0xE9204530)
    if struct.unpack_from("<II", data, first) != (0xE99C0198, 0xE99C019C):
        raise PatchError("rebuilt application lost the day/month pointer swap")


def write_minfs_config(path: Path) -> None:
    path.write_text(
        "[IMAGE_CFG]\n"
        "size=7880\n\n"
        "[COMPRESS_EXT]\n"
        "count=5\n"
        "compress0=drv\n"
        "compress1=mod\n"
        "compress2=plg\n"
        "compress3=img\n"
        "compress4=axf\n",
        encoding="ascii",
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create the tested UK-date F3 Pro firmware from a clean owner-supplied dump."
    )
    parser.add_argument("input", type=Path, help="clean 8 MiB SPI dump")
    parser.add_argument("output", type=Path, help="new complete flash image")
    parser.add_argument(
        "--minfs",
        type=Path,
        default=Path("minfs"),
        help="path to the Melis minfs utility (default: minfs in PATH)",
    )
    args = parser.parse_args()

    try:
        source = args.input.read_bytes()
        if len(source) != FLASH_SIZE:
            raise PatchError(
                f"input size is {len(source)} bytes; expected {FLASH_SIZE} (0x800000)"
            )
        digest = sha256(source)
        if digest != SUPPORTED_SHA256:
            raise PatchError(
                "unsupported input firmware\n"
                f"  received: {digest}\n"
                f"  expected: {SUPPORTED_SHA256}"
            )
        if args.output.resolve() == args.input.resolve():
            raise PatchError("refusing to overwrite the original dump")

        minfs = shutil.which(str(args.minfs))
        if minfs is None:
            raise PatchError(f"cannot find minfs utility: {args.minfs}")

        with tempfile.TemporaryDirectory(prefix="f3pro-date-") as temporary:
            work = Path(temporary)
            original_rootfs = work / "original.minfs"
            extracted = work / "rootfs"
            rebuilt_rootfs = work / "rebuilt.minfs"
            verify_tree = work / "verify"
            config = work / "rootfs.ini"

            original_rootfs.write_bytes(
                source[ROOTFS_OFFSET : ROOTFS_OFFSET + ROOTFS_SIZE]
            )
            extracted.mkdir()
            run([minfs, "dump", str(original_rootfs), str(extracted)])

            leopard = extracted / "apps" / "leopard.axf"
            if not leopard.is_file():
                raise PatchError("MinFS does not contain apps/leopard.axf")
            patch_leopard(leopard)

            write_minfs_config(config)
            run([minfs, "make", str(extracted), str(rebuilt_rootfs), str(config)])
            rebuilt = rebuilt_rootfs.read_bytes()
            if len(rebuilt) != ROOTFS_SIZE:
                raise PatchError(
                    f"rebuilt MinFS size is {len(rebuilt)}; expected {ROOTFS_SIZE}"
                )

            verify_tree.mkdir()
            run([minfs, "dump", str(rebuilt_rootfs), str(verify_tree)])
            verify_patched_leopard(verify_tree / "apps" / "leopard.axf")

            output = bytearray(source)
            output[ROOTFS_OFFSET : ROOTFS_OFFSET + ROOTFS_SIZE] = rebuilt
            if len(output) != FLASH_SIZE:
                raise PatchError("internal error: output flash size changed")
            if output[:ROOTFS_OFFSET] != source[:ROOTFS_OFFSET]:
                raise PatchError("internal error: boot area changed")
            tail = ROOTFS_OFFSET + ROOTFS_SIZE
            if output[tail:] != source[tail:]:
                raise PatchError("internal error: persistent/tail area changed")

            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_bytes(output)

        print("\nUpdate created successfully")
        print(f"  Output:  {args.output}")
        print(f"  Size:    {args.output.stat().st_size} bytes (0x800000)")
        print(f"  SHA-256: {sha256(args.output.read_bytes())}")
        print("\nThis image is experimental. Read it back and compare after flashing.")
        return 0
    except (OSError, PatchError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
