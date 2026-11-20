import { expect, it } from 'vitest'
import { ubuntuAcceptance } from '../../scripts/ubuntu-acceptance'
it.skipIf(!process.env.VPS_TEST_CONFIG)(
  'performs real Ubuntu SSH/SFTP acceptance checks in an isolated directory',
  async () => {
    expect((await ubuntuAcceptance()).length).toBeGreaterThan(10)
  },
  180000,
)
