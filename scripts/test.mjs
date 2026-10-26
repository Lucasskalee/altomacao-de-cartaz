import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const directory = await mkdtemp(join(tmpdir(), 'skalee-tests-'));
try {
  const outfile = join(directory,'cartazes.test.cjs');
  await build({ entryPoints: ['tests/cartazes.test.tsx'], bundle: true, platform: 'node', format: 'cjs', outfile });
  const result = spawnSync(process.execPath,['--test',outfile],{ stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { await rm(directory,{recursive:true,force:true}); }
