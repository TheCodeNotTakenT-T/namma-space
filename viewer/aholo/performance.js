// Frame intervals include browser/GPU scheduling, not just render submission time.
export class ResolutionBudget {
  constructor() { this.scale=1; this.samples=[]; this.elapsed=0; }
  reset(scale=1) { this.scale=scale; this.samples=[]; this.elapsed=0; }
  sample(ms, active=true) {
    // Embedded browsers may throttle a nominally visible tab to one callback/second.
    // Do not reduce quality in response to those suspension-sized gaps.
    if(!active || !Number.isFinite(ms) || ms<=0 || ms>500) {this.samples=[];this.elapsed=0;return false;}
    this.samples.push(ms);this.elapsed+=ms;
    if(this.elapsed<1800 || this.samples.length<20)return false;
    const sorted=this.samples.slice().sort((a,b)=>a-b);
    const p90=sorted[Math.floor((sorted.length-1)*.9)];
    const before=this.scale;
    // Hysteresis and bounded changes prevent rapid resolution oscillation.
    if(p90>19)this.scale=Math.max(.5, +(this.scale-.1).toFixed(2));
    else if(p90<15)this.scale=Math.min(1, +(this.scale+.05).toFixed(2));
    this.samples=[];this.elapsed=0;
    return before!==this.scale;
  }
}
