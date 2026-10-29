import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";
export class ScreenBoundary extends Component<
  { children: ReactNode; screen: string },
  { error: string | null }
> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  componentDidCatch(e: Error, info: ErrorInfo) {
    console.error(e, info.componentStack);
  }
  componentDidUpdate(previous: { screen: string }) {
    if (previous.screen !== this.props.screen && this.state.error)
      this.setState({ error: null });
  }
  render() {
    return this.state.error ? (
      <div role="alert" className="settings-section">
        <h2>Раздел не удалось показать</h2>
        <p>{this.state.error}</p>
        <button
          className="button secondary"
          onClick={() => this.setState({ error: null })}
        >
          Повторить открытие
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
