import type {Project} from '../Project';
import {
  PromiseSimpleEventDispatcher,
  SimpleEventDispatcher,
} from 'strongly-typed-events';

const MAX_AUDIO_DESYNC = 1 / 50;

export interface PlayerState {
  duration: number;
  frame: number;
  startFrame: number;
  paused: boolean;
  loading: boolean;
  finished: boolean;
  loop: boolean;
  speed: number;
  render: boolean;
}

interface PlayerCommands {
  reset: boolean;
  seek: number;
}

export interface PlayerRenderEvent {
  frame: number;
  blob: Blob;
}

const STORAGE_KEY = 'player-state';

export class Player {
  public get StateChanged() {
    return this.stateChanged.asEvent();
  }

  public get RenderChanged() {
    return this.renderChanged.asEvent();
  }

  private readonly stateChanged = new SimpleEventDispatcher<PlayerState>();
  private readonly renderChanged =
    new PromiseSimpleEventDispatcher<PlayerRenderEvent>();

  private readonly audio: HTMLAudioElement = null;
  private startTime: number;
  private audioError = false;

  private state: PlayerState = {
    duration: 100,
    frame: 0,
    startFrame: 0,
    paused: true,
    loading: false,
    finished: false,
    loop: true,
    speed: 1,
    render: false,
  };

  private commands: PlayerCommands = {
    reset: true,
    seek: -1,
  };

  public updateState(newState: Partial<PlayerState>) {
    this.state = {
      ...this.state,
      ...newState,
    };
    this.stateChanged.dispatch(this.state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
  }

  private consumeCommands(): PlayerCommands {
    const commands = {...this.commands};
    this.commands.reset = false;
    this.commands.seek = -1;

    return commands;
  }

  public constructor(public readonly project: Project, audioSrc?: string) {
    this.startTime = performance.now();

    const savedState = localStorage.getItem(STORAGE_KEY);
    if (savedState) {
      const state = JSON.parse(savedState) as PlayerState;
      this.state.paused = state.paused;
      this.state.startFrame = state.startFrame;
      this.state.loop = state.loop;
      this.state.speed = state.speed;
    }

    if (audioSrc) {
      this.audio = new Audio(audioSrc);
      this.audio.addEventListener('durationchange', () => {
        this.updateState({
          duration: this.project.secondsToFrames(this.audio.duration),
        });
        this.requestSeek(this.state.duration);
      });
    }

    this.request();
  }

  public requestNextFrame(): void {
    this.commands.seek = this.state.frame + 1;
  }

  public requestReset(): void {
    this.commands.seek = 0;
  }

  public requestSeek(value: number): void {
    this.commands.seek = value;
    if (value < this.state.startFrame) {
      this.updateState({startFrame: value});
    }
  }

  public togglePlayback(value?: boolean): void {
    this.updateState({
      paused: !(value ?? this.state.paused),
    });
  }

  public toggleRendering(value?: boolean): void {
    this.updateState({
      render: !(value ?? this.state.render),
    });
  }

  private async run() {
    let commands = this.consumeCommands();
    let state = {...this.state};
    if (state.finished && state.loop && commands.seek < 0) {
      commands.seek = 0;
    }

    // Pause / play audio.
    const audioPaused = state.paused || state.finished || state.render;
    if (this.audio && this.audio.paused !== audioPaused) {
      if (audioPaused) {
        this.audio.pause();
      } else {
        try {
          await this.audio.play();
          this.syncAudio(-3);
          this.audioError = false;
        } catch (e) {
          this.audioError = true;
        }
      }
    }

    // Rendering
    if (state.render) {
      state.finished = await this.project.next();
      this.project.draw();
      await this.renderChanged.dispatch({
        frame: this.project.frame,
        blob: await this.getContent(),
      });
      if (state.finished) {
        state.render = false;
      }

      this.updateState({
        finished: state.finished,
        render: state.render,
        frame: this.project.frame,
      });
      this.request();
      return;
    }

    // Seek to the given frame
    if (commands.seek >= 0 || this.project.frame < state.startFrame) {
      const seekFrame = Math.max(commands.seek, state.startFrame);
      state.finished = await this.project.seek(seekFrame, state.speed);
      this.syncAudio(-3);
    }
    // Do nothing if paused or is ahead of the audio.
    else if (
      state.paused ||
      (state.speed === 1 &&
        this.hasAudio() &&
        this.audio.currentTime < this.project.time)
    ) {
      this.request();
      return;
    }
    // Seek to synchronize animation with audio.
    else if (
      this.hasAudio() &&
      state.speed === 1 &&
      this.project.time < this.audio.currentTime - MAX_AUDIO_DESYNC
    ) {
      const seekFrame = this.project.secondsToFrames(this.audio.currentTime);
      state.finished = await this.project.seek(seekFrame, state.speed);
    }
    // Simply move forward one frame
    else {
      state.finished = await this.project.next(state.speed);

      // Synchronize audio.
      if (state.speed !== 1) {
        this.syncAudio();
      }
    }

    // Draw the project
    this.project.draw();

    // handle finishing
    if (state.finished) {
      state.duration = this.project.frame;
    }

    this.updateState({
      finished: state.finished,
      duration: state.duration,
      frame: this.project.frame,
    });

    this.request();
  }

  private hasAudio(): boolean {
    return this.audio && !this.audioError;
  }

  private syncAudio(frameOffset: number = 0) {
    if (!this.audio) return;

    this.audio.currentTime = Math.max(
      0,
      this.project.framesToSeconds(this.project.frame + frameOffset),
    );
  }

  private request() {
    requestAnimationFrame(async () => {
      try {
        this.updateState({loading: true});
        await this.run();
        this.updateState({loading: false});
      } catch (e) {
        console.error(e);
      }
    });
  }

  private async getContent(): Promise<Blob> {
    return new Promise<Blob>(resolve =>
      this.project.toCanvas().toBlob(resolve, 'image/png'),
    );
  }
}