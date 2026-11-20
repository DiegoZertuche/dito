/**
 * THE INTEGRATION LANE'S SHARDS, BALANCED (ticket #390). CI runs the lane
 * on three runners, `--shard=i/3` each. Vitest's own split orders files by
 * a hash of their path and cuts the list into equal counts, which put
 * 820 s of the lane's serial time on one runner and 280 s on another; the
 * slowest runner is the job's wall time.
 *
 * This split assigns the largest file to the lightest shard, largest first,
 * by byte size — a deterministic input every runner sees identically, so
 * the three shards always partition the files: none runs twice, none is
 * left out. Size is the proxy because it is the input every runner shares;
 * a duration record differs runner to runner and could not partition. Ties
 * break on the path. Ordering within a shard stays vitest's own (longest
 * recorded duration first).
 */
import { statSync } from "node:fs";
import { BaseSequencer, type TestSpecification } from "vitest/node";

export class SizeBalancedSequencer extends BaseSequencer {
  override shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return Promise.resolve(files);
    return Promise.resolve(shardBySize(files, shard.index, shard.count, (spec) => statSync(spec.moduleId).size));
  }
}

/** Largest first onto the lightest bin; the files in bin `index` (1-based) of `count`. */
export function shardBySize<T extends { moduleId: string }>(
  files: readonly T[],
  index: number,
  count: number,
  sizeOf: (file: T) => number,
): T[] {
  const sized = files
    .map((file) => ({ file, size: sizeOf(file) }))
    .sort((a, b) => b.size - a.size || (a.file.moduleId < b.file.moduleId ? -1 : 1));
  const bins = Array.from({ length: count }, () => ({ bytes: 0, files: [] as T[] }));
  for (const { file, size } of sized) {
    const lightest = bins.reduce((min, bin) => (bin.bytes < min.bytes ? bin : min));
    lightest.bytes += size;
    lightest.files.push(file);
  }
  return bins[index - 1]!.files;
}
