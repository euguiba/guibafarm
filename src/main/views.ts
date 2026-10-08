// Uma WebContentsView por conta, cada uma na sua partição. A janela mostra a conta
// selecionada ou todas as abertas em grade.

import { WebContentsView, type BaseWindow } from 'electron';
import type { Profile } from './store';

export const SIDEBAR_WIDTH = 340;

export type LayoutMode = 'single' | 'grid';

export class ViewManager {
  private views = new Map<string, WebContentsView>();
  private selected: string | undefined;
  private mode: LayoutMode = 'single';

  constructor(private readonly win: BaseWindow) {
    win.on('resize', () => this.layout());
  }

  open(profile: Profile, url: string, onCreated: (view: WebContentsView) => void): WebContentsView {
    let view = this.views.get(profile.id);
    if (!view) {
      view = new WebContentsView({
        webPreferences: {
          partition: profile.partition,
          contextIsolation: true,
          sandbox: true,
        },
      });
      this.views.set(profile.id, view);
      this.win.contentView.addChildView(view);
      onCreated(view);
      void view.webContents.loadURL(url);
    }
    this.selected = profile.id;
    this.layout();
    return view;
  }

  close(profileId: string): void {
    const view = this.views.get(profileId);
    if (!view) return;
    this.win.contentView.removeChildView(view);
    view.webContents.close();
    this.views.delete(profileId);
    if (this.selected === profileId) this.selected = this.views.keys().next().value;
    this.layout();
  }

  get(profileId: string): WebContentsView | undefined {
    return this.views.get(profileId);
  }

  openIds(): string[] {
    return [...this.views.keys()];
  }

  selectedId(): string | undefined {
    return this.selected;
  }

  setMode(mode: LayoutMode): void {
    this.mode = mode;
    this.layout();
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
