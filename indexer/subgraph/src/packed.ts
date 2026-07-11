import { BigInt, Bytes } from "@graphprotocol/graph-ts";

export class PackedAmounts {
  x: BigInt;
  y: BigInt;

  constructor(x: BigInt, y: BigInt) {
    this.x = x;
    this.y = y;
  }
}

function unsignedBigEndianSliceToBigInt(data: Bytes, start: i32, end: i32): BigInt {
  const reversed = new Bytes(end - start);

  for (let i = 0; i < end - start; i++) {
    reversed[i] = data[end - 1 - i];
  }

  return BigInt.fromUnsignedBytes(reversed);
}

export function decodePackedAmounts(packed: Bytes): PackedAmounts {
  // LB encode(x, y) stores token X in the low 128 bits, which are the last 16 bytes in Graph's big-endian Bytes.
  return new PackedAmounts(
    unsignedBigEndianSliceToBigInt(packed, 16, 32),
    unsignedBigEndianSliceToBigInt(packed, 0, 16)
  );
}
