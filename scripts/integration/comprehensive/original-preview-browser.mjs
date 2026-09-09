import{chromium,expect}from'@playwright/test';
import{readFileSync,writeFileSync,mkdirSync}from'node:fs';
import{authenticatedApi}from'./auth.mjs';
const out=process.argv[2],f=JSON.parse(readFileSync(out+'/original-preview-fixture.json','utf8')),results=[];
const owner=await authenticatedApi(out),other=await authenticatedApi(out,'other'),browser=await chromium.launch({headless:true});
const check=id=>{results.push({id,status:'PASS'});console.log(id+' PASS');};
async function call(subject,path,data,status=200){const response=await subject.api.post(path,{headers:subject.headers,data});expect(response.status(),path).toBe(status);return response;}
try{
 const context=await browser.newContext({baseURL:owner.fixture.baseURL,storageState:owner.state,viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.clock.install();await page.goto('/security-alerts');await page.getByTestId('alert-row-'+f.alertId).getByRole('button').click();await page.getByRole('tab',{name:'命中证据',exact:true}).click();
 const sources=page.locator('section[aria-label="独立原件审批"]'),pdfCard=sources.locator(':scope > div').filter({has:page.getByRole('spinbutton',{name:'申请查看的 PDF 页码'})});
 await expect(pdfCard).toBeVisible();await pdfCard.getByRole('spinbutton').fill('1');
 await pdfCard.getByRole('button',{name:'一次性查看',exact:true}).click();
 const preview=page.getByRole('region',{name:'经独立审批的原件预览'});await expect(preview).toContainText('PDF 第 1 / 2 页');await expect(preview.locator('img')).toBeVisible();
 await expect(preview.locator('svg rect')).toHaveCount(0);
 const image=preview.locator('img');await expect.poll(()=>image.evaluate(element=>element.complete&&element.naturalWidth>0)).toBe(true);
 mkdirSync(out+'/screenshots',{recursive:true});await page.screenshot({path:out+'/screenshots/original-pdf-page.png',animations:'disabled'});
 await page.getByRole('button',{name:'关闭并清除'}).click();await expect(preview).toHaveCount(0);await expect(page.locator('img[src^="data:"]')).toHaveCount(0);
 check('PDF_REAL_BROWSER_IMAGE_PAGE_BINDING_AND_CLEAR');
 const audioCard=sources.locator(':scope > div').filter({hasText:f.audioArtifactId.slice(0,8)});
 await audioCard.getByRole('button',{name:'一次性查看',exact:true}).click();const audio=preview.locator('audio');
 await expect(audio).toBeVisible();await expect.poll(()=>audio.evaluate(element=>element.readyState)).toBeGreaterThan(0);
 await preview.getByRole('button',{name:/跳转/}).click();await expect.poll(()=>audio.evaluate(element=>element.currentTime)).toBeCloseTo(.5,1);
 await expect(preview.getByRole('list',{name:'当前播放位置关联证据'})).toBeVisible();await page.screenshot({path:out+'/screenshots/original-audio-location.png',animations:'disabled'});
 await page.getByRole('button',{name:'关闭并清除'}).click();await expect(page.locator('audio')).toHaveCount(0);check('AUDIO_REAL_BROWSER_SEEK_ASSOCIATION_AND_CLEAR');
 await pdfCard.getByRole('spinbutton').fill('2');
 const approved=await(await call(owner,'/api/media-originals/'+encodeURIComponent(f.pdfId)+'/raw-access',{purpose:'REGULATORY_REVIEW',reason:'Synthetic browser independent original page approval'})).json();
 await call(other,'/api/content-access-requests/'+approved.data.id+'/review',{action:'approve',reason:'Independent browser test review'});
 await page.reload();await page.getByTestId('alert-row-'+f.alertId).getByRole('button').click();await page.getByRole('tab',{name:'命中证据',exact:true}).click();
 const second=page.locator('section[aria-label="独立原件审批"] > div').filter({has:page.getByRole('spinbutton',{name:'申请查看的 PDF 页码'})});
 await second.getByRole('button',{name:'一次性查看',exact:true}).last().click();await expect(preview).toContainText('PDF 第 2 / 2 页');await expect(preview.locator('svg rect')).toHaveCount(1);
 check('PDF_VERIFIED_REGION_APPEARS_ONLY_ON_BOUND_PAGE');
 await page.clock.fastForward(61000);await expect(preview).toHaveCount(0);await expect(page.getByRole('button',{name:'关闭并清除'})).toHaveCount(0);
 check('AUTOMATIC_PREVIEW_CLEAR_AFTER_60_SECONDS');
 await page.getByTestId('evidence-access-MEDIA_EVIDENCE-'+f.snapshotId).getByRole('button',{name:'一次性查看',exact:true}).click();const review=page.getByRole('region',{name:'支持证据与反证'});await expect(review).toBeVisible();await expect(review).toContainText('反证 · 已排除该候选');await expect(review.locator('mark')).toHaveCount(2);await page.screenshot({path:out+'/screenshots/authorized-support-counter.png',animations:'disabled'});await page.getByRole('button',{name:'关闭并清除'}).click();await expect(review).toHaveCount(0);check('SUPPORT_COUNTER_EVIDENCE_HIGHLIGHT_AND_CLEAR');
 await expect(page.locator('iframe,object,embed')).toHaveCount(0);expect(errors).toEqual([]);check('NO_ACTIVE_PDF_EMBED_OR_BROWSER_ERRORS');
 await context.close();
}catch(error){results.push({id:'ORIGINAL-PREVIEW-BROWSER',status:'FAIL',error:error.message.slice(0,900)});process.exitCode=1;}
finally{await browser.close();await owner.api.dispose();await other.api.dispose();writeFileSync(out+'/original-preview-browser.json',JSON.stringify({scope:'REAL_BROWSER_HTTP_PG_MINIO_PDF_RENDERER_SYNTHETIC',results},null,2));}
