// Modo Electron: uma WebContentsView por conta, cada uma na sua partição. A janela
// mostra a conta selecionada ou todas as abertas em grade.

import { shell, WebContentsView, type BaseWindow } from 'electron';
import type { PageControl } from '../core/actions';
import type { BrowserHost, LayoutMode } from '../core/app-core';
import type { Profile } from '../core/store';
import type { CapturedEvent, GameModule } from '../sdk/types';
import { attachCapture } from './capture';

export const SIDEBAR_WIDTH = 340;

export class ElectronHost implements BrowserHost {
  private views = new Map<string, WebContentsView>();
  private detachers = new Map<string, () => void>();
  private selected: string | undefined;
  private mode: LayoutMode = 'single';

  constructor(private readonly win: BaseWindow) {
    win.on('resize', () => this.layout());
  }

  async open(profile: Profile, game: GameModule, onCaptured: (event: CapturedEvent) => void): Promise<void> {
    if (!this.views.has(profile.id)) {
      const view = new WebContentsView({
        webPreferences: { partition: profile.partition, contextIsolation: true, sandbox: true },
      });
      this.views.set(profile.id, view);
      this.win.contentView.addChildView(view);
      if (game.manifest.policy.read) {
        this.detachers.set(profile.id, attachCapture(view.webContents, game.manifest.hosts, onCaptured));
      }
      // Links que abrem nova janela vão para o navegador padrão, fora da partição da conta.
      view.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: 'deny' };
      });
      void view.webContents.loadURL(game.manifest.startUrl);
    }
    this.selected = profile.id;
    this.layout();
  }

  async close(profileId: string): Promise<void> {
    this.detachers.get(profileId)?.();
    this.detachers.delete(profileId);
    const view = this.views.get(profileId);
    if (!view) return;
    this.win.contentView.removeChildView(view);
    view.webContents.close();
    this.views.delete(profileId);
    if (this.selected === profileId) this.selected = this.views.keys().next().value;
    this.layout();
  }

  openIds(): string[] {
    return [...this.views.keys()];
  }

  setLayout(mode: LayoutMode): void {
    this.mode = mode;
    this.layout();
  }

  page(profileId: string): PageControl | undefined {
    const wc = this.views.get(profileId)?.webContents;
    if (!wc) return undefined;
    return {
      evaluate: (js) => wc.executeJavaScript(js, true),
      click: async (x, y) => {
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      },
    };
  }

  private layout(): void {
    const { width, height } = this.win.getContentBounds();
    const x0 = SIDEBAR_WIDTH;
    const w = Math.max(0, width - x0);
    const ids = [...this.views.keys()];

    if (this.mode === 'single') {
      for (const id of ids) {
        const view = this.views.get(id)!;
        const visible = id === this.selected;
        view.setVisible(visible);
        if (visible) view.setBounds({ x: x0, y: 0, width: w, height });
      }
      return;
    }

    const cols = Math.ceil(Math.sqrt(ids.length));
    const rows = Math.max(1, Math.ceil(ids.length / cols));
    const cw = Math.floor(w / Math.max(1, cols));
    const ch = Math.floor(height / rows);
    ids.forEach((id, i) => {
      const view = this.views.get(id)!;
      view.setVisible(true);
      view.setBounds({ x: x0 + (i % cols) * cw, y: Math.floor(i / cols) * ch, width: cw, height: ch });
    });
  }
}
