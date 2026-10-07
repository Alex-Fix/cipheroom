import { selectedIcePath, StatsLike } from './ice-path';

function report(stats: Record<string, unknown>[]): StatsLike {
  const map = new Map(stats.map((s) => [s['id'] as string, s]));
  return { get: (id) => map.get(id), forEach: (cb) => map.forEach((v) => cb(v)) };
}

describe('selectedIcePath', () => {
  it('follows transport.selectedCandidatePairId (Chromium/Safari)', () => {
    const path = selectedIcePath(
      report([
        { id: 't', type: 'transport', selectedCandidatePairId: 'p2' },
        { id: 'p1', type: 'candidate-pair', localCandidateId: 'l1', remoteCandidateId: 'r1' },
        {
          id: 'p2',
          type: 'candidate-pair',
          localCandidateId: 'l2',
          remoteCandidateId: 'r1',
          currentRoundTripTime: 0.0425,
        },
        { id: 'l1', type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
        {
          id: 'l2',
          type: 'local-candidate',
          candidateType: 'relay',
          protocol: 'udp',
          relayProtocol: 'tls',
        },
        { id: 'r1', type: 'remote-candidate', candidateType: 'srflx', address: '203.0.113.7' },
      ]),
    );

    expect(path).toEqual({
      localType: 'relay',
      remoteType: 'srflx',
      protocol: 'udp',
      relayProtocol: 'tls',
      remoteAddress: '203.0.113.7',
      rttMs: 43,
    });
  });

  it('falls back to the selected pair flag (Firefox)', () => {
    const path = selectedIcePath(
      report([
        {
          id: 'p',
          type: 'candidate-pair',
          selected: true,
          localCandidateId: 'l',
          remoteCandidateId: 'r',
        },
        { id: 'l', type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
        { id: 'r', type: 'remote-candidate', candidateType: 'host', address: '192.168.1.10' },
      ]),
    );

    expect(path?.localType).toBe('host');
    expect(path?.remoteAddress).toBe('192.168.1.10');
  });

  it('returns undefined before ICE has selected a pair', () => {
    expect(selectedIcePath(report([{ id: 't', type: 'transport' }]))).toBeUndefined();
  });
});
