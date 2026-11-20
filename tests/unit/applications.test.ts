import { describe, expect, it } from 'vitest'
import {
  packageName,
  packageProtection,
  parseActualRemoval,
  parseSimulatedRemoval,
  equalPackageNames,
} from '../../src/domain/applications/policy'
import type { InstalledPackage } from '../../src/domain/applications/types'
import { parsePackageInventory } from '../../src/application/applications/application-manager'
import { aptRemovalCommand } from '../../src/infrastructure/commands/applications'
const pkg: InstalledPackage = {
  name: 'hello',
  version: '1',
  architecture: 'amd64',
  size: 10,
  description: 'test',
  manual: true,
  held: false,
  essential: false,
  protected: false,
  priority: 'optional',
}
describe('package inventory and protection', () => {
  it('parses real dpkg columns and APT marks', () => {
    const raw =
      '__UID__\n1000\n__MANUAL__\nhello\n__HELD__\nheld-app\n__PACKAGES__\nhello\t1\tamd64\t12\tno\tno\toptional\tinstalled\tFriendly package\nbash\t5\tamd64\t200\tyes\tno\trequired\tinstalled\tShell\ngone\t1\tamd64\t1\tno\tno\toptional\tconfig-files\tOld\n__SNAPSHOT__\n' +
      'a'.repeat(64) +
      '  /var/lib/dpkg/status\n'
    const parsed = parsePackageInventory(raw)
    expect(parsed.uid).toBe(1000)
    expect(parsed.packages).toHaveLength(2)
    expect(parsed.packages.find((value) => value.name === 'hello')).toMatchObject({
      manual: true,
      size: 12288,
      description: 'Friendly package',
    })
    expect(parsed.packages[0].protectedReason).toBeTruthy()
  })
  it.each([
    'openssh-server',
    'systemd',
    'apt',
    'sudo',
    'linux-image-generic',
    'netplan.io',
    'libc6:amd64',
    'grub-pc',
  ])('protects core package %s', (name) => expect(packageProtection({ ...pkg, name })).toBeTruthy())
  it('protects holds and metadata flags without declaring every optional package removable', () => {
    expect(packageProtection({ ...pkg, held: true })).toBeTruthy()
    expect(packageProtection({ ...pkg, protected: true })).toBeTruthy()
    expect(packageProtection(pkg)).toBeUndefined()
  })
  it.each(['--help', 'hello;reboot', 'hello$(id)', 'hello=1', 'hello*', '../hello', 'hello\napt'])(
    'rejects package expression %j',
    (value) => expect(() => packageName(value)).toThrow(),
  )
  it('allows exact Debian identifiers and multiarch names', () =>
    expect(packageName('libfoo++:amd64')).toBe('libfoo++:amd64'))
})
describe('APT proposal matching', () => {
  it('extracts removals and rejects install/configuration side effects', () => {
    expect(parseSimulatedRemoval('Remv hello [1]\nRemv app [2]\n')).toEqual(['app', 'hello'])
    expect(() => parseSimulatedRemoval('Inst other [1]\nRemv hello [1]')).toThrow()
    expect(() => parseSimulatedRemoval('Conf other [1]')).toThrow()
  })
  it('matches a wrapped real proposal and its count', () => {
    expect(
      parseActualRemoval(
        'The following packages will be REMOVED:\n  hello app\n  another\n0 upgraded, 0 newly installed, 3 to remove and 0 not upgraded.\nDo you want to continue? [Y/n] ',
      ),
    ).toEqual(['another', 'app', 'hello'])
    expect(equalPackageNames(['hello'], ['different'])).toBe(false)
  })
  it('rejects unexpected installations, counts and missing sections', () => {
    expect(() =>
      parseActualRemoval(
        'The following packages will be REMOVED:\n  hello\n0 upgraded, 1 newly installed, 1 to remove',
      ),
    ).toThrow()
    expect(() =>
      parseActualRemoval(
        'The following packages will be REMOVED:\n  hello\n0 upgraded, 0 newly installed, 2 to remove',
      ),
    ).toThrow()
    expect(() => parseActualRemoval('unknown')).toThrow()
  })
  it('never puts a yes flag, purge, autoremove or password into the removal command', () => {
    const command = aptRemovalCommand('hello', 'sudo')
    expect(command).toContain('sudo -n -- /usr/bin/apt-get')
    expect(command).toContain('Assume-Yes=false')
    expect(command).not.toContain(' -y ')
    expect(command).not.toContain(' --purge')
    expect(command).toContain("remove -- 'hello'")
  })
})
