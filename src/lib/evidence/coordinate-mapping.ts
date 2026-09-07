export type Region=readonly[number,number,number,number];
export type Affine=readonly[number,number,number,number,number,number];
/** Maps view-normalized coordinates back to the display-oriented source page. */
export function mapRegion(region:Region,matrix:Affine):[number,number,number,number]{
 if(![...region,...matrix].every(Number.isFinite)||region.some(n=>n<0||n>1)||region[2]<region[0]||region[3]<region[1])throw new Error('EVIDENCE_COORDINATE_INVALID');
 const [a,b,c,d,e,f]=matrix;
 if(Math.abs(a*e-b*d)<1e-12)throw new Error('EVIDENCE_MAPPING_SINGULAR');
 const points=[[region[0],region[1]],[region[2],region[1]],[region[0],region[3]],[region[2],region[3]]].map(([x,y])=>[a*x+b*y+c,d*x+e*y+f]);
 if(points.some(p=>p.some(n=>n< -1e-8||n>1+1e-8)))throw new Error('EVIDENCE_MAPPING_OUTSIDE_SOURCE');
 const clamp=(n:number)=>Math.max(0,Math.min(1,n));
 return [clamp(Math.min(...points.map(p=>p[0]))),clamp(Math.min(...points.map(p=>p[1]))),clamp(Math.max(...points.map(p=>p[0]))),clamp(Math.max(...points.map(p=>p[1])))];
}
export function inverseRotation(degrees:number):Affine{
 if(degrees===90)return [0,1,0,-1,0,1];if(degrees===180)return [-1,0,1,0,-1,1];if(degrees===270)return [0,-1,1,1,0,0];if(degrees===0)return [1,0,0,0,1,0];throw new Error('EVIDENCE_ROTATION_UNSUPPORTED');
}
export function tileMapping(width:number,height:number,row:number,column:number,rows:number,columns:number){
 if(![width,height,row,column,rows,columns].every(Number.isSafeInteger)||width<1||height<1||rows<1||columns<1||row<0||row>=rows||column<0||column>=columns)throw new Error('EVIDENCE_TILE_INVALID');
 const x=Math.floor(width*column/columns),y=Math.floor(height*row/rows),w=Math.floor(width*(column+1)/columns)-x,h=Math.floor(height*(row+1)/rows)-y;
 if(w<1||h<1)throw new Error('EVIDENCE_TILE_EMPTY');
 return {x,y,width:w,height:h,matrix:[w/width,0,x/width,0,h/height,y/height] as Affine};
}
