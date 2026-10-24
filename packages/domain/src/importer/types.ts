export type ColumnType = 'text' | 'integer' | 'decimal' | 'date' | 'boolean' | 'enum';

/** Which date spellings a file may use (setting `import_date_formats`, BR-5). */
export type DateFormats = 'iso' | 'dmy' | 'both';

export interface ColumnDef {
  /** Header text in the file; matched ignoring case and surrounding spaces. */
  name: string;
  type: ColumnType;
  required: boolean;
  /** One synthetic example value for the template (BR-8); must itself validate. */
  example: string;
  /** Allowed values of an `enum` column. */
  allowed?: readonly string[];
  maxLength?: number;
  note?: string;
}

/** A cleaned cell: decimals stay strings, integers are numbers, dates are `yyyy-mm-dd`. */
export type CellValue = string | number | boolean | null;
export type ImportRecord = Record<string, CellValue>;

export interface RowError {
  /** Spreadsheet row number: the header is row 1, the first data row is row 2. */
  rowNo: number;
  column: string;
  message: string;
}

export interface ValidatedTable {
  /** Records of the non-blank data rows, with the spreadsheet row number of each. */
  records: { rowNo: number; record: ImportRecord }[];
  errors: RowError[];
}

export interface TemplateContent {
  header: string[];
  example: string[];
  notes: string[][];
}
