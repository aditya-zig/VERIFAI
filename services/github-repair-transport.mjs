function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function validatePatch(patch) {
  if (!patch||!Array.isArray(patch.files)||patch.files.length<1||patch.files.length>8) throw new Error('verified patch files are required');
  const seen=new Set();
  for (const file of patch.files) {
    if (!file||typeof file.path!=='string'||!file.path||file.path.startsWith('/')||file.path.split(/[\\/]+/).includes('..')) throw new Error('invalid verified patch path');
    if (seen.has(file.path)) throw new Error('duplicate verified patch path');
    seen.add(file.path);
    if (typeof file.expected!=='string'||typeof file.replacement!=='string') throw new Error('verified patch expected/replacement text required');
  }
}

async function responseJson(response) {
  const body=await response.json().catch(()=>({}));
  if (!response.ok) {
    const message=typeof body?.message==='string'?body.message:'HTTP '+response.status;
    throw new Error('GitHub request failed: '+message);
  }
  return body;
}

export function createGitHubRepairTransport({token,fetchImpl=fetch,apiBase='https://api.github.com'}={}) {
  if (typeof token!=='string'||!token) throw new Error('GitHub token is required');
  const base=apiBase.replace(/\/+$/,'');
  const request=async(method,path,body)=>{
    const response=await fetchImpl(base+path,{
      method,
      headers:{
        accept:'application/vnd.github+json',
        authorization:'Bearer '+token,
        'content-type':'application/json',
        'x-github-api-version':'2022-11-28',
      },
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    });
    return responseJson(response);
  };
  const refPath=(repository,branch)=>'/repos/'+repository+'/git/ref/heads/'+encodeURIComponent(branch);

  return {
    async createBranch({repository,baseBranch,branch}) {
      const baseRef=await request('GET',refPath(repository,baseBranch));
      const sha=baseRef?.object?.sha;
      if (typeof sha!=='string'||!sha) throw new Error('GitHub base branch ref missing SHA');
      await request('POST','/repos/'+repository+'/git/refs',{ref:'refs/heads/'+branch,sha});
      return {sha};
    },

    async commitVerifiedPatch({repository,branch,patch,commitMessage}) {
      validatePatch(patch);
      const branchRef=await request('GET',refPath(repository,branch));
      const parentSha=branchRef?.object?.sha;
      if (typeof parentSha!=='string'||!parentSha) throw new Error('GitHub repair branch ref missing SHA');

      const parentCommit=await request('GET','/repos/'+repository+'/git/commits/'+encodeURIComponent(parentSha));
      const baseTreeSha=parentCommit?.tree?.sha;
      if (typeof baseTreeSha!=='string'||!baseTreeSha) throw new Error('GitHub parent commit missing tree SHA');

      const treeListing=await request('GET','/repos/'+repository+'/git/trees/'+encodeURIComponent(baseTreeSha)+'?recursive=1');
      const entries=[];
      for (const file of patch.files) {
        const current=await request('GET','/repos/'+repository+'/contents/'+encodePath(file.path)+'?ref='+encodeURIComponent(branch));
        if (typeof current?.content!=='string'||current?.encoding!=='base64') throw new Error('GitHub file content unavailable for '+file.path);
        const before=Buffer.from(current.content.replace(/\n/g,''),'base64').toString('utf8');
        const first=before.indexOf(file.expected);
        const last=before.lastIndexOf(file.expected);
        if (first<0||first!==last) throw new Error('verified patch no longer applies cleanly: '+file.path);
        const after=before.slice(0,first)+file.replacement+before.slice(first+file.expected.length);
        const blob=await request('POST','/repos/'+repository+'/git/blobs',{content:after,encoding:'utf-8'});
        const originalEntry=Array.isArray(treeListing?.tree)?treeListing.tree.find((item)=>item?.path===file.path):undefined;
        if (!originalEntry||originalEntry.type!=='blob'||typeof originalEntry.mode!=='string') throw new Error('Git tree entry unavailable for '+file.path);
        entries.push({path:file.path,mode:originalEntry.mode,type:'blob',sha:blob.sha});
      }

      const tree=await request('POST','/repos/'+repository+'/git/trees',{base_tree:baseTreeSha,tree:entries});
      if (typeof tree?.sha!=='string'||!tree.sha) throw new Error('GitHub tree creation missing SHA');
      const commit=await request('POST','/repos/'+repository+'/git/commits',{
        message:commitMessage,
        tree:tree.sha,
        parents:[parentSha],
      });
      if (typeof commit?.sha!=='string'||!commit.sha) throw new Error('GitHub commit creation missing SHA');
      return {commitSha:commit.sha};
    },

    async pushBranch({repository,branch,commitSha}) {
      await request('PATCH','/repos/'+repository+'/git/refs/heads/'+encodeURIComponent(branch),{sha:commitSha,force:false});
      return {ok:true};
    },

    async openPullRequest({repository,baseBranch,headBranch,title,body}) {
      const pr=await request('POST','/repos/'+repository+'/pulls',{
        title,
        body,
        head:headBranch,
        base:baseBranch,
        draft:false,
        maintainer_can_modify:true,
      });
      return {number:pr.number,url:pr.html_url};
    },
  };
}
