import {
  OrderBy,
  WhereClause,
} from '../../../components/Common/utils/v1QueryUtils';
import Endpoints from '../../../Endpoints';
import { ReduxState } from '../../../types';
import { BaseTableColumn, Relationship, Table } from '../../types';

type Tables = ReduxState['tables'];
interface GetGraphQLQuery {
  allSchemas: Table[];
  view: Tables['view'];
  originalTable: string;
  currentSchema: string;
  isExport?: boolean;
}

export const SQLServerTypes = {
  character: [
    'char',
    'varchar',
    'text',
    'nchar',
    'nvarchar',
    'binary',
    'vbinary',
    'image',
  ],
  numeric: [
    'bit',
    'tinyint',
    'smallint',
    'int',
    'bigint',
    'decimal',
    'numeric',
    'smallmoney',
    'money',
    'float',
    'real',
  ],
  dateTime: [
    'datetime',
    'smalldatetime',
    'date',
    'time',
    'datetimeoffset',
    'timestamp',
  ],
  user_defined: [],
};

const getFormattedValue = (
  type: string,
  value: any
): string | number | undefined => {
  if (
    SQLServerTypes.character.includes(type) ||
    SQLServerTypes.dateTime.includes(type)
  )
    return `"${value}"`;

  if (SQLServerTypes.numeric.includes(type)) return value;
};

const RqlToGraphQlOp = (op: string) => {
  if (!op || !op?.startsWith('$')) return 'none';
  return op.replace('$', '_');
};

const generateWhereClauseQueryString = (
  wheres: WhereClause[],
  columnTypeInfo: BaseTableColumn[]
): string | null => {
  const whereClausesArr = wheres.map((i: Record<string, any>) => {
    const columnName = Object.keys(i)[0];
    const RqlOperator = Object.keys(i[columnName])[0];
    const value = i[columnName][RqlOperator];
    const type = columnTypeInfo?.find(c => c.column_name === columnName)
      ?.data_type_name;
    return `${columnName}: {${RqlToGraphQlOp(RqlOperator)}: ${getFormattedValue(
      type || 'varchar',
      value
    )} }`;
  });
  return whereClausesArr.length
    ? `where: {${whereClausesArr.join(',')}}`
    : null;
};

const generateSortClauseQueryString = (sorts: OrderBy[]): string | null => {
  const sortClausesArr = sorts.map((i: OrderBy) => {
    return `${i.column}: ${i.type}`;
  });
  return sortClausesArr.length
    ? `order_by: {${sortClausesArr.join(',')}}`
    : null;
};

const getColQuery = (
  cols: (string | { name: string; columns: string[] })[],
  limit: number,
  relationships: Relationship[]
): string[] => {
  return cols.map(c => {
    if (typeof c === 'string') return c;
    const rel = relationships.find((r: any) => r.rel_name === c.name);
    return `${c.name} ${
      rel?.rel_type === 'array' ? `(limit: ${limit})` : ''
    } { ${getColQuery(c.columns, limit, relationships).join('\n')} }`;
  });
};

export const getGraphQLQueryForBrowseRows = ({
  allSchemas,
  view,
  originalTable,
  currentSchema,
  isExport,
}: GetGraphQLQuery) => {
  const currentTable: Table | undefined = allSchemas?.find(
    (t: Table) =>
      t.table_name === originalTable && t.table_schema === currentSchema
  );
  const columnTypeInfo: BaseTableColumn[] = currentTable?.columns || [];
  const relationshipInfo: Relationship[] = currentTable?.relationships || [];

  if (!columnTypeInfo) {
    throw new Error('Error in finding column info for table');
  }

  let whereConditions: WhereClause[] = [];
  let isRelationshipView = false;
  if (view.query.where) {
    if (view.query.where.$and) {
      whereConditions = view.query.where.$and;
    } else {
      isRelationshipView = true;
      whereConditions = Object.keys(view.query.where)
        .filter(k => view.query.where[k])
        .map(k => {
          const obj = {} as any;
          obj[k] = { $eq: view.query.where[k] };
          return obj;
        });
    }
  }
  const sortConditions: OrderBy[] = [];
  if (view.query.order_by) {
    sortConditions.push(...view.query.order_by);
  }
  const limit = isExport ? null : `limit: ${view.curFilter.limit}`;
  const offset = isExport
    ? null
    : `offset: ${!isRelationshipView ? view.curFilter.offset : 0}`;
  const clauses = `${[
    generateWhereClauseQueryString(whereConditions, columnTypeInfo),
    generateSortClauseQueryString(sortConditions),
    limit,
    offset,
  ]
    .filter(Boolean)
    .join(',')}`;

  return `query TableRows {
      ${
        currentSchema === 'dbo'
          ? originalTable
          : `${currentSchema}_${originalTable}`
      } ${clauses && `(${clauses})`} {
          ${getColQuery(
            view.query.columns,
            view.curFilter.limit,
            relationshipInfo
          ).join('\n')}
      } 
    }
  `;
};

const getTableRowRequestBody = (tables: Tables, isExport?: boolean) => {
  const {
    currentTable: originalTable,
    view,
    allSchemas,
    currentSchema,
  } = tables;

  return {
    query: getGraphQLQueryForBrowseRows({
      allSchemas,
      view,
      originalTable,
      currentSchema,
      isExport,
    }),
    variables: null,
    operationName: 'TableRows',
  };
};

const processTableRowData = (
  data: any,
  config?: { originalTable: string; currentSchema: string }
) => {
  const { originalTable, currentSchema } = config!;
  const rows =
    data.data[
      currentSchema === 'dbo'
        ? originalTable
        : `${currentSchema}_${originalTable}`
    ];
  return { estimatedCount: rows.length, rows };
};

export const generateTableRowRequest = () => {
  return {
    endpoint: Endpoints.graphQLUrl,
    getTableRowRequestBody,
    processTableRowData,
  };
};
