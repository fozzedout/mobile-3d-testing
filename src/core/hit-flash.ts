/** A brief full-screen red flash for collision feedback, shared by the obstacle courses. */
export class HitFlash {
  private readonly el: HTMLDivElement;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "hit-flash";
    document.body.appendChild(this.el);
  }

  trigger(): void {
    this.el.style.transition = "none";
    this.el.style.opacity = "0.55";
    void this.el.offsetHeight; // force reflow so the fade-out below actually animates
    this.el.style.transition = "opacity 400ms ease-out";
    this.el.style.opacity = "0";
  }

  dispose(): void {
    this.el.remove();
  }
}
