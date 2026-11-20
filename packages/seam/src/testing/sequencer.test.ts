import { describe, expect, it } from "vitest";
import { shardBySize } from "./sequencer.js";

const file = (moduleId: string, size: number) => ({ moduleId, size });
const FILES = [
  file("/a.int.test.ts", 50),
  file("/b.int.test.ts", 40),
  file("/c.int.test.ts", 30),
  file("/d.int.test.ts", 30),
  file("/e.int.test.ts", 10),
];

describe("the integration lane's size-balanced shards (ticket #390)", () => {
  it("partitions the files: every file in exactly one shard", () => {
    const shards = [1, 2, 3].map((index) => shardBySize(FILES, index, 3, (f) => f.size));
    const all = shards.flat().map((f) => f.moduleId).sort();
    expect(all).toEqual(FILES.map((f) => f.moduleId).sort());
  });

  it("puts the largest file on the lightest shard, largest first", () => {
    const sizes = [1, 2, 3].map((index) =>
      shardBySize(FILES, index, 3, (f) => f.size).reduce((sum, f) => sum + f.size, 0),
    );
    expect(sizes).toEqual([50, 50, 60]);
  });

  it("answers the same split whatever order the files arrive in", () => {
    const reversed = [...FILES].reverse();
    for (const index of [1, 2, 3]) {
      expect(shardBySize(reversed, index, 3, (f) => f.size)).toEqual(
        shardBySize(FILES, index, 3, (f) => f.size),
      );
    }
  });
});
