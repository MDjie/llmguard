/** Bounded process cache. bytes represents the caller's conservative allocation estimate. */
export class BoundedCache<K,V> {
  private readonly entries=new Map<K,{value:V;bytes:number;expires:number}>();
  private bytes=0;
  private hits=0;
  private misses=0;
  private evictions=0;
  private expired=0;
  private rejected=0;
  constructor(private readonly maximumEntries:number,private readonly maximumBytes:number,private readonly ttlMs:number,private readonly now:()=>number=Date.now) {
    if(![maximumEntries,maximumBytes,ttlMs].every(value=>Number.isSafeInteger(value)&&value>0))throw new Error('INVALID_CACHE_BUDGET');
  }
  get(key:K):V|undefined {
    const entry=this.entries.get(key);
    if(!entry){this.misses++;return undefined;}
    if(entry.expires<=this.now()){this.remove(key);this.expired++;this.misses++;return undefined;}
    this.entries.delete(key);this.entries.set(key,entry);this.hits++;return entry.value;
  }
  set(key:K,value:V,bytes:number):boolean {
    this.remove(key);
    if(!Number.isSafeInteger(bytes)||bytes<1||bytes>this.maximumBytes){this.rejected++;return false;}
    const now=this.now();
    for(const [candidate,entry] of this.entries)if(entry.expires<=now){this.remove(candidate);this.expired++;}
    while(this.entries.size>=this.maximumEntries||this.bytes+bytes>this.maximumBytes){
      const first=this.entries.keys().next();if(first.done)break;this.remove(first.value);this.evictions++;
    }
    this.entries.set(key,{value,bytes,expires:now+this.ttlMs});this.bytes+=bytes;return true;
  }
  private remove(key:K):void { const entry=this.entries.get(key);if(entry){this.bytes-=entry.bytes;this.entries.delete(key);} }
  clear():void {this.entries.clear();this.bytes=0;}
  stats(){return {entries:this.entries.size,estimatedBytes:this.bytes,hits:this.hits,misses:this.misses,evictions:this.evictions,expired:this.expired,rejected:this.rejected};}
}
