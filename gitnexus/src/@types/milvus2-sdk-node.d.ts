declare module '@zilliz/milvus2-sdk-node' {
  export class MilvusClient {
    constructor(config: Record<string, unknown>);
    hasCollection(params: { collection_name: string }): Promise<{ value: boolean }>;
    createCollection(params: {
      collection_name: string;
      fields: Array<{
        name: string;
        data_type: string;
        is_primary_key?: boolean;
        autoID?: boolean;
        dim?: number;
        max_length?: number;
      }>;
    }): Promise<any>;
    createIndex(params: {
      collection_name: string;
      field_name: string;
      index_name: string;
      params: Record<string, unknown>;
    }): Promise<any>;
    loadCollectionSync(params: { collection_name: string }): Promise<any>;
    insert(params: { collection_name: string; data: Record<string, unknown>[] }): Promise<any>;
    delete(params: { collection_name: string; filter: string }): Promise<any>;
    search(params: {
      collection_name: string;
      vector: number[];
      limit: number;
      output_fields: string[];
      expr?: string;
      params: Record<string, unknown>;
    }): Promise<{ results: Array<Record<string, unknown> & { score?: number }> }>;
    query(params: {
      collection_name: string;
      expr?: string;
      output_fields: string[];
      limit?: number;
    }): Promise<{ data: Record<string, unknown>[] }>;
    count(params: { collection_name: string; expr?: string }): Promise<{ data: number }>;
    flushSync(params: { collection_names: string[] }): Promise<any>;
    close(): Promise<void>;
    dropCollection(params: { collection_name: string }): Promise<any>;
  }
}
