import { Injectable, signal } from '@angular/core';
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr';
import { ClientEvents, HubMethods, JoinResult, ParticipantDto, RtcConfig } from './signaling.types';

/** App signaling over SignalR. Media signaling is LiveKit's job — never add SDP/ICE here. */
@Injectable({ providedIn: 'root' })
export class SignalingService {
  private connection?: HubConnection;

  readonly connected = signal(false);
  readonly participants = signal<ParticipantDto[]>([]);

  async joinRoom(roomId: string, displayName: string): Promise<JoinResult> {
    const connection = await this.ensureConnected();
    const result = await connection.invoke<JoinResult>(HubMethods.JoinRoom, roomId, displayName);
    this.participants.set(result.participants);
    return result;
  }

  async getRtcConfig(): Promise<RtcConfig> {
    return (await this.ensureConnected()).invoke<RtcConfig>(HubMethods.GetRtcConfig);
  }

  async leave(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.participants.set([]);
    // Stopping the connection also leaves the room server-side (OnDisconnectedAsync).
    await connection?.stop();
  }

  private async ensureConnected(): Promise<HubConnection> {
    if (this.connection?.state === HubConnectionState.Connected) return this.connection;

    const connection = new HubConnectionBuilder()
      .withUrl('/hubs/room')
      .configureLogging(LogLevel.Warning)
      .build();

    connection.on(ClientEvents.ParticipantJoined, (p: ParticipantDto) =>
      this.participants.update((list) => [...list, p]),
    );
    connection.on(ClientEvents.ParticipantLeft, (id: string) =>
      this.participants.update((list) => list.filter((p) => p.id !== id)),
    );
    connection.onclose(() => this.connected.set(false));

    await connection.start();
    this.connection = connection;
    this.connected.set(true);
    return connection;
  }
}
