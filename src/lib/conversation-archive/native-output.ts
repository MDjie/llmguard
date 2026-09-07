/** Inventory only: this never supplies semantic coverage or a release permit. */
export function nativeOutputArchiveCoverage(raw:unknown,representation:'MODEL_RESPONSE_JSON'|'SSE_EVENT'|string):{detected:boolean;originalsEmbedded:boolean}{
 let value=raw;if(representation==='SSE_EVENT'){if(!raw||typeof raw!=='object'||!('data' in raw)||typeof raw.data!=='string')return{detected:false,originalsEmbedded:true};try{value=JSON.parse(raw.data);}catch{return{detected:false,originalsEmbedded:true};}}
 if(!value||typeof value!=='object'||!('choices' in value)||!Array.isArray(value.choices))return{detected:false,originalsEmbedded:true};
 let detected=false,originalsEmbedded=true;
 const inline=(value:unknown)=>typeof value==='string'&&/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/i.test(value);
 for(const choice of value.choices){if(!choice||typeof choice!=='object')continue;for(const name of ['message','delta']){const message:unknown=Reflect.get(choice,name);if(!message||typeof message!=='object')continue;
  for(const key of ['audio','images','video'])if(Object.hasOwn(message,key)&&Reflect.get(message,key)!=null){detected=true;const media:unknown=Reflect.get(message,key);if(!(key==='audio'&&media&&typeof media==='object'&&'data' in media&&typeof media.data==='string'&&media.data.length>0))originalsEmbedded=false;}
  const content:unknown=Reflect.get(message,'content');if(!Array.isArray(content))continue;
  for(const block of content){if(!block||typeof block!=='object')continue;const kind:unknown=Reflect.get(block,'type');if(typeof kind!=='string'||!['image_url','input_audio','output_audio','video_url','image','audio','video'].includes(kind))continue;detected=true;const media:unknown=Reflect.get(block,kind);if(!media||typeof media!=='object'){originalsEmbedded=false;continue;}if(['image_url','video_url'].includes(kind)){if(!inline(Reflect.get(media,'url')))originalsEmbedded=false;}else if(!('data' in media)||typeof media.data!=='string'||!media.data.length)originalsEmbedded=false;}
 }}
 return{detected,originalsEmbedded};
}
