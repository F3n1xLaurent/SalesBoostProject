import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export type SimulationEvent = { atMs: number; type: string; detail?: string };
type AudioClip = { atMs: number; pcm: Buffer; channel: 0 | 1 };

export function decodeMuLaw(value: number): number {
  const byte = (~value) & 255;
  const magnitude = (((byte & 15) << 3) + 132) << ((byte >> 4) & 7);
  return (byte & 128) ? 132 - magnitude : magnitude - 132;
}

export function pcmWave(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Vox protocol emulator. Audio runs at wall-clock speed, including overlap. */
export class SimulatedVoxSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly events: SimulationEvent[] = [];
  readonly clips: AudioClip[] = [];
  readonly startedAt = Date.now();
  outputEnabled = false;
  hungUp = false;
  playing = false;
  private tailAt = 0;
  private current = false;
  private firstPacket = true;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  get now(): number { return Date.now() - this.startedAt; }
  private later(fn: () => void, delay: number): void {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, Math.max(0, delay));
    this.timers.add(timer);
  }
  private status(status: 'started' | 'ended'): void {
    this.emit('message', Buffer.from(JSON.stringify({ customEvent: 'media_status', status, tag: 'assistant' })));
  }
  send(raw: string): void {
    if (this.readyState !== WebSocket.OPEN) return;
    const message = JSON.parse(raw);
    if (message.customEvent === 'control') {
      this.events.push({ atMs: this.now, type: message.action, detail: JSON.stringify(message) });
      if (message.action === 'set_output_enabled') this.outputEnabled = Boolean(message.enabled);
      if (message.action === 'clear_media' || (message.action === 'set_output_enabled' && !message.enabled)) this.clearPlayback();
      if (message.action === 'hangup') { this.hungUp = true; this.events.push({ atMs: this.now, type: 'hangup' }); }
      return;
    }
    if (message.event === 'start') { this.current = true; this.firstPacket = true; return; }
    if (message.event === 'media' && this.current) {
      if (!this.outputEnabled) return;
      const bytes = Buffer.from(message.media.payload, 'base64');
      const pcm = Buffer.alloc(bytes.length * 2);
      bytes.forEach((value, index) => pcm.writeInt16LE(decodeMuLaw(value), index * 2));
      const at = Math.max(this.now + (this.firstPacket ? 80 : 0), this.tailAt);
      this.tailAt = at + bytes.length / 8;
      this.clips.push({ atMs: at, pcm, channel: 1 });
      if (this.firstPacket) {
        this.firstPacket = false;
        this.later(() => {
          this.playing = true;
          this.events.push({ atMs: this.now, type: 'playback_started' });
          this.status('started');
        }, at - this.now);
      }
    }
    if (message.event === 'stop' && this.current) {
      this.current = false;
      this.later(() => {
        this.playing = false;
        this.events.push({ atMs: this.now, type: 'playback_ended' });
        this.status('ended');
      }, Math.max(0, this.tailAt - this.now) + 80);
    }
  }
  private clearPlayback(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    // Discard packets queued for the future and trim the currently playing one.
    for (let i = this.clips.length - 1; i >= 0; i--) {
      const clip = this.clips[i];
      if (clip.channel !== 1) continue;
      if (clip.atMs >= this.now) this.clips.splice(i, 1);
      else if (clip.atMs + clip.pcm.length / 16 > this.now) {
        clip.pcm = clip.pcm.subarray(0, Math.max(0, Math.floor((this.now - clip.atMs) * 8) * 2));
      }
    }
    this.current = false; this.playing = false; this.tailAt = this.now;
  }
  input(frame: Buffer): void {
    if (this.readyState !== WebSocket.OPEN || this.hungUp) return;
    this.emit('message', Buffer.from(JSON.stringify({ event: 'media', media: { payload: frame.toString('base64') } })));
  }
  recordManager(pcm16: Buffer, detail: string): void {
    // Input is 16k PCM; recording uses 8k stereo like the telephone output.
    const pcm8 = Buffer.alloc(Math.floor(pcm16.length / 4) * 2);
    for (let i = 0; i < pcm8.length / 2; i++) pcm8.writeInt16LE(pcm16.readInt16LE(i * 4), i * 2);
    this.clips.push({ atMs: this.now, pcm: pcm8, channel: 0 });
    this.events.push({ atMs: this.now, type: 'manager_started', detail });
  }
  recording(): Buffer {
    const lengthMs = Math.max(this.now, ...this.clips.map((c) => c.atMs + c.pcm.length / 16));
    const out = Buffer.alloc(Math.ceil(lengthMs * 8) * 4);
    for (const clip of this.clips) {
      const start = Math.floor(clip.atMs * 8);
      for (let i = 0; i + 1 < clip.pcm.length; i += 2) {
        const offset = (start + i / 2) * 4 + clip.channel * 2;
        if (offset + 2 <= out.length) out.writeInt16LE(clip.pcm.readInt16LE(i), offset);
      }
    }
    return pcmWave(out, 8000, 2);
  }
  close(): void {
    if (this.readyState !== WebSocket.OPEN) return;
    this.readyState = WebSocket.CLOSED;
    this.clearPlayback();
    this.emit('close');
  }
}
