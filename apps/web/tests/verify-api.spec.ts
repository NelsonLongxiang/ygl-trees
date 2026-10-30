import {afterEach,describe,it,expect,vi} from 'vitest';
import {fetchVerifyReports,fetchVerifyArchives} from '../src/api';
afterEach(()=>vi.unstubAllGlobals());
describe('#125 frontend paged contract',()=>{
 it('requests one bounded spec/filter/cursor page and preserves server metadata',async()=>{const page={items:[{run_id:'r'}],total:500,next_cursor:'next'};const fake=vi.fn().mockResolvedValue({ok:true,json:async()=>page});vi.stubGlobal('fetch',fake);expect(await fetchVerifyReports('spec x','opaque+',true)).toEqual(page);const u=new URL(fake.mock.calls[0][0],'http://local/');expect(u.searchParams.get('spec')).toBe('spec x');expect(u.searchParams.get('limit')).toBe('30');expect(u.searchParams.get('cursor')).toBe('opaque+');expect(u.searchParams.get('only_bad')).toBe('1');});
 it('archives also use bounded cursor pages and errors are not treated as empty',async()=>{const fake=vi.fn().mockResolvedValue({ok:true,json:async()=>({items:[],total:0,next_cursor:null})});vi.stubGlobal('fetch',fake);expect(await fetchVerifyArchives('a')).toMatchObject({total:0,next_cursor:null});expect(fake.mock.calls[0][0]).toContain('limit=200');fake.mockResolvedValue({ok:false,status:500});await expect(fetchVerifyReports('s')).rejects.toThrow('500');});
});
