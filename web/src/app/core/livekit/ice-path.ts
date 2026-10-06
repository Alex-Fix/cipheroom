/** Minimal view of RTCStatsReport so this stays unit-testable. */
export interface StatsLike {
  get(id: string): any;
  forEach(callback: (value: any) => void): void;
}

export interface IcePath {
  /** host | srflx | prflx | relay */
  localType: string;
  remoteType: string;
  protocol: string;
  /** Transport to the TURN server when localType is relay (udp | tcp | tls). */
  relayProtocol?: string;
  remoteAddress?: string;
  rttMs?: number;
}

/** Finds the ICE candidate pair a peer connection is actually using. */
export function selectedIcePath(report: StatsLike): IcePath | undefined {
  let pair: any;
  report.forEach((stat) => {
    if (stat.type === 'transport' && stat.selectedCandidatePairId) {
      pair = report.get(stat.selectedCandidatePairId);
    }
  });
  // Firefox has no transport.selectedCandidatePairId; it flags the pair instead.
  if (!pair) {
    report.forEach((stat) => {
      if (stat.type === 'candidate-pair' && (stat.selected || (stat.nominated && stat.state === 'succeeded'))) {
        pair ??= stat;
      }
    });
  }
  if (!pair) return undefined;

  const local = report.get(pair.localCandidateId);
  const remote = report.get(pair.remoteCandidateId);
  if (!local || !remote) return undefined;

  return {
    localType: local.candidateType,
    remoteType: remote.candidateType,
    protocol: local.protocol,
    relayProtocol: local.relayProtocol,
    remoteAddress: remote.address ?? remote.ip,
    rttMs: pair.currentRoundTripTime !== undefined ? Math.round(pair.currentRoundTripTime * 1000) : undefined,
  };
}
