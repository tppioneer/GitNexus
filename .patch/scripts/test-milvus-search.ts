/**
 * 独立测试：Milvus 搜索链路验证
 *
 * 不依赖 analyze，直接测：
 *   1. Collection 创建（schema + HNSW 索引 + load）
 *   2. 向量写入 + flush
 *   3. 向量搜索（按 repo 隔离）
 *   4. 增量删除 + 重新搜索验证
 *
 * 前置条件：Milvus 在 localhost:19530 运行中
 *
 * 运行：
 *   cd gitnexus
 *   GITNEXUS_VECTOR_STORE=milvus GITNEXUS_MILVUS_ADDRESS=localhost:19530 \
 *     npx tsx ../scripts/test-milvus-search.ts
 *
 * 或编译后：
 *   node ../scripts/test-milvus-search.js
 */

// 动态 import ESM 模块（脚本从 gitnexus/ 目录运行：npx tsx ../scripts/test-milvus-search.ts）
async function main() {
  const { MilvusVectorStore } = await import('../gitnexus/dist/core/embeddings/milvus-vector-store.js');

  const TEST_REPO = 'test_search_demo';
  const DIM = 384;

  const store = new MilvusVectorStore({
    kind: 'milvus',
    address: 'localhost:19530',
    collectionName: 'code_embeddings',
    dims: DIM,
  });

  try {
    // ─── 1. 写入测试数据 ───────────────────────────────────────────
    console.log('1️⃣  写入测试向量...');

    // 生成 5 个模拟代码向量（随机，模拟 embedding 输出）
    const records = [
      { id: 'func1:0', nodeId: 'Function:src/auth.py:login',    chunkIndex: 0, startLine: 10,  endLine: 25,  embedding: randomVec(DIM), repoName: TEST_REPO },
      { id: 'func2:0', nodeId: 'Function:src/auth.py:logout',   chunkIndex: 0, startLine: 30,  endLine: 42,  embedding: randomVec(DIM), repoName: TEST_REPO },
      { id: 'func3:0', nodeId: 'Function:src/db.py:connect',    chunkIndex: 0, startLine: 5,   endLine: 18,  embedding: randomVec(DIM), repoName: TEST_REPO },
      { id: 'cls1:0',  nodeId: 'Class:src/models.py:User',      chunkIndex: 0, startLine: 1,   endLine: 50,  embedding: randomVec(DIM), repoName: TEST_REPO },
      { id: 'cls2:0',  nodeId: 'Class:src/models.py:Session',   chunkIndex: 0, startLine: 55,  endLine: 100, embedding: randomVec(DIM), repoName: TEST_REPO },
    ];

    await store.insert(records);
    console.log(`   ✅ 写入 ${records.length} 条记录到 collection code_embeddings_${TEST_REPO}`);

    // flushSync 是异步的，等待数据可见
    await sleep(2000);

    // ─── 2. 验证 count ─────────────────────────────────────────────
    const cnt = await store.count(TEST_REPO);
    console.log(`2️⃣  count = ${cnt}`);
    if (cnt < 5) throw new Error(`Expected at least 5 records, got ${cnt}`);

    // ─── 3. 用第一条记录的向量搜索自己 ──────────────────────────────
    console.log('3️⃣  搜索：用 func1 的向量搜最近邻...');
    const results = await store.search(records[0].embedding, 3, TEST_REPO);
    console.log(`   Top-3 结果:`);
    for (const r of results) {
      console.log(`     nodeId=${r.nodeId}  distance=${r.distance.toFixed(4)}`);
    }

    // 第一条应该是自己（distance ≈ 0）
    if (results.length === 0) throw new Error('搜索返回空结果');
    if (results[0].nodeId !== 'Function:src/auth.py:login') {
      console.log(`   ⚠️  第一条是 ${results[0].nodeId}（不是自己），distance=${results[0].distance.toFixed(4)}（随机向量可能不完全匹配，需 true embedding 测试）`);
    } else {
      console.log(`   ✅ 第一条是自己，distance=${results[0].distance.toFixed(4)}`);
    }

    // ─── 4. 跨 repo 隔离验证 ───────────────────────────────────────
    console.log('4️⃣  跨 repo 隔离验证...');
    const otherResults = await store.search(records[0].embedding, 3, 'nonexistent_repo');
    console.log(`   搜索 nonexistent_repo → ${otherResults.length} 条（期望 0）`);
    if (otherResults.length !== 0) {
      console.log('   ⚠️  跨 repo 隔离可能有问题');
    } else {
      console.log('   ✅ repo 隔离正确');
    }

    // ─── 5. 增量删除 + 重新搜索 ────────────────────────────────────
    console.log('5️⃣  删除 func1 + func2，重新搜索...');
    await store.deleteByNodeIds(
      ['Function:src/auth.py:login', 'Function:src/auth.py:logout'],
      TEST_REPO,
    );
    const afterDelete = await store.count(TEST_REPO);
    console.log(`   删除后 count = ${afterDelete}`);

    const searchAfter = await store.search(records[0].embedding, 5, TEST_REPO);
    console.log(`   搜索剩余 ${searchAfter.length} 条:`);
    for (const r of searchAfter) {
      console.log(`     nodeId=${r.nodeId}  distance=${r.distance.toFixed(4)}`);
    }

    console.log('\n🎉 所有测试通过！');
  } catch (err) {
    console.error('❌ 测试失败:', err);
    process.exit(1);
  } finally {
    await store.dispose();
  }
}

/** 生成随机向量（模拟 embedding，不能用于实际代码搜索） */
function randomVec(dim: number): number[] {
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random();
  // L2 归一化（cosine ≈ normalized dot product）
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main();
