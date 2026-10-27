import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectAndQueuePendingEnrichment } from '../src/handlers/enrichment';
import type { Env } from '../src/types';
const day = 86400000;
beforeAll(async () => {
  await env.DB.exec('CREATE TABLE IF NOT EXISTS enriched_beers (id TEXT PRIMARY KEY,brew_name TEXT,brewer TEXT,description_hash TEXT,enrichment_status TEXT,abv REAL,updated_at INTEGER,last_seen_at INTEGER)');
});
async function seed(id:string,status:string,age:number,seenAge=0,abv:number|null=null,name='Great Heights Leo Carillo') {
  const now=Date.now();
  await env.DB.prepare('INSERT INTO enriched_beers VALUES (?,?,?,?,?,?,?,?)').bind(id,name,'Great Heights','source-hash',status,abv,now-age,now-seenAge).run();
}
function context() {
  const sendBatch=vi.fn().mockResolvedValue(undefined);
  return {sendBatch,worker:{...env,ENRICHMENT_QUEUE:{sendBatch}} as unknown as Env};
}
describe('recover temporary ABV lookup misses',()=>{
  beforeEach(async()=>{
    await env.DB.prepare('DELETE FROM enriched_beers').run();
  });
  it('requeues an expired recently seen miss with original identity and hash',async()=>{
    await seed('21720679','not_found',day+1000);
    const {worker,sendBatch}=context();
    expect((await selectAndQueuePendingEnrichment(worker,{limit:1})).beersQueued).toBe(1);
    expect(sendBatch).toHaveBeenCalledWith([{body:{beerId:'21720679',beerName:'Great Heights Leo Carillo',brewer:'Great Heights',descriptionHash:'source-hash'}}]);
    expect(await env.DB.prepare('SELECT enrichment_status FROM enriched_beers WHERE id=?').bind('21720679').first('enrichment_status')).toBe('pending');
    // Another explicit unknown starts a fresh cooldown, not a refresh loop.
    await env.DB.prepare('UPDATE enriched_beers SET enrichment_status=?,updated_at=? WHERE id=?').bind('not_found',Date.now(),'21720679').run();
    sendBatch.mockClear();
    expect((await selectAndQueuePendingEnrichment(worker,{limit:1})).beersQueued).toBe(0);
    expect(sendBatch).not.toHaveBeenCalled();
  });
  it('does not reopen fresh misses, unavailable beers, failures, exclusions or known ABVs',async()=>{
    await seed('fresh','not_found',day-1000);
    await seed('gone','not_found',2*day,8*day);
    await seed('failed','failed',2*day);
    await seed('skipped','skipped',2*day);
    await seed('known','not_found',2*day,0,5.8);
    const {worker,sendBatch}=context();
    expect((await selectAndQueuePendingEnrichment(worker,{limit:10})).beersQueued).toBe(0);
    expect(sendBatch).not.toHaveBeenCalled();
  });
  it('bounds recovery by the normal requested batch size',async()=>{
    for(const id of ['a','b','c']) await seed(id,'not_found',2*day);
    const {worker,sendBatch}=context();
    expect((await selectAndQueuePendingEnrichment(worker,{limit:2})).beersQueued).toBe(2);
    expect(sendBatch.mock.calls[0]?.[0]).toHaveLength(2);
    expect(await env.DB.prepare("SELECT count(*) as n FROM enriched_beers WHERE enrichment_status='not_found'").first('n')).toBe(1);
  });
  it('skips blocklisted rows so they cannot starve valid pending work',async()=>{
    await seed('flight','not_found',3*day,0,null,'Texas Flight');
    await seed('mixed','pending',2*day,0,null,'Build Your Flight');
    await seed('pilsner','pending',day,0,null,'Pilsner');
    const {worker,sendBatch}=context();
    const status=(id:string)=>env.DB.prepare('SELECT enrichment_status FROM enriched_beers WHERE id=?').bind(id).first('enrichment_status');
    expect(await selectAndQueuePendingEnrichment(worker,{limit:2})).toMatchObject({beersQueued:0,blocklistedMarked:2});
    expect(sendBatch).not.toHaveBeenCalled();
    expect(await status('flight')).toBe('skipped');
    expect(await status('mixed')).toBe('skipped');
    expect((await selectAndQueuePendingEnrichment(worker,{limit:2})).beersQueued).toBe(1);
    expect(sendBatch.mock.calls[0]?.[0]).toEqual([expect.objectContaining({body:expect.objectContaining({beerId:'pilsner'})})]);
  });
});
