declare module '@zilliz/milvus2-sdk-node' {
  export class MilvusClient {
    /** Resolves once gRPC connection is established. Must be awaited before any calls. */
    connectPromise: Promise<void>;

    constructor(config: Record<string, unknown>);

    hasCollection(params: { collection_name: string }): Promise<{ value: boolean }>;

    /** v2.6.x: custom schema uses `schema` (not `fields`). */
    createCollection(params: {
      collection_name: string;
      schema: Array<{
        name: string;
        data_type: string;
        is_primary_key?: boolean;
        autoID?: boolean;
        /** v2.6.x: VarChar max_length and FloatVector dim live inside type_params */
        type_params?: Record<string, string | number>;
      }>;
      enable_dynamic_field?: boolean;
      /** Providing index_params at creation time auto-loads the collection. */
      index_params?: Array<{
        field_name: string;
        index_name: string;
        index_type: string;
        metric_type: string;
        params?: Record<string, unknown>;
      }>;
    }): Promise<any>;

    createIndex(params: {
      collection_name: string;
      field_name: string;
      index_name: string;
      index_type: string;
      metric_type: string;
      params?: Record<string, unknown>;
    }): Promise<any>;

    loadCollectionSync(params: { collection_name: string }): Promise<any>;

    insert(params: { collection_name: string; data: Record<string, unknown>[] }): Promise<any>;

    /** v2.6.x: filter (not expr) is the scalar filtering clause for delete. */
    delete(params: { collection_name: string; filter: string }): Promise<any>;

    /** v2.6.x: data is number[] (single) or number[][] (batch). */
    search(params: {
      collection_name: string;
      data: number[] | number[][];
      limit: number;
      output_fields: string[];
      params?: Record<string, unknown>;
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
