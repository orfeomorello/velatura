import { describe, expect, it } from 'vitest';
import { defaultSdnextRoot, sdnextLauncherName, sdnextRootCandidates } from '../src/paths.js';

describe('SD.Next location suggestions', () => {
  it('uses the current user profile and checks C:\sdnext on Windows', () => {
    const home = 'C:\\Users\\Ilaria';
    const env = {
      USERPROFILE: home,
      SystemDrive: 'C:',
      PUBLIC: 'C:\\Users\\Public',
    };
    const candidates = sdnextRootCandidates('win32', home, env);
    expect(defaultSdnextRoot('win32', home, env)).toBe('C:\\Users\\Ilaria\\sdnext');
    expect(candidates).toContain('C:\\sdnext');
    expect(candidates).toContain('C:\\AI\\sdnext');
    expect(candidates).toContain('C:\\Users\\Ilaria\\Documents\\sdnext');
    expect(candidates.every((candidate) => candidate.includes('\\'))).toBe(true);
    expect(sdnextLauncherName('win32')).toBe('webui.bat');
  });

  it('uses a home-folder default and Unix paths on Linux and macOS', () => {
    for (const platform of ['linux', 'darwin']) {
      const home = '/home/ilaria';
      const candidates = sdnextRootCandidates(platform, home, {});
      expect(defaultSdnextRoot(platform, home, {})).toBe('/home/ilaria/sdnext');
      expect(candidates).toContain('/home/ilaria/sdnext');
      expect(candidates).toContain('/home/ilaria/Documents/SD.Next');
      expect(candidates.some((candidate) => candidate.startsWith('C:'))).toBe(false);
      expect(sdnextLauncherName(platform)).toBe('webui.sh');
    }
  });

  it('includes common system-wide and macOS checkout locations', () => {
    const linux = sdnextRootCandidates('linux', '/home/ilaria', {});
    expect(linux).toContain('/opt/sdnext');
    expect(linux).toContain('/srv/sdnext');

    const mac = sdnextRootCandidates('darwin', '/Users/ilaria', {});
    expect(mac).toContain('/Applications/SD.Next');
    expect(mac).toContain('/Users/ilaria/Applications/sdnext');
  });

  it('deduplicates Windows paths case-insensitively', () => {
    const home = 'C:\\Users\\Ilaria';
    const candidates = sdnextRootCandidates('win32', home, {
      USERPROFILE: home,
      SystemDrive: 'c:',
      PUBLIC: 'C:\\Users\\Public',
    });
    expect(candidates.filter((candidate) => candidate.toLowerCase() === 'c:\\sdnext')).toHaveLength(1);
  });
});
