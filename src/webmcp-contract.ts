/**
 * The part of the WebMCP action contract this package consumes.
 *
 * Declared here rather than imported, so that type-only information does not
 * require a runtime dependency. These shapes mirror the WebMCP SDK's exports
 * and can be widened as that contract grows.
 *
 * @module
 */

/**
 * The value types a property specification may declare.
 *
 * The crawler folds time inputs into `date`, and marks file inputs `file`.
 */
export type NxisValueType = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'file';

/** One choice in a property's enumerated options. */
export interface NxisValueOption {
  '@type'?: 'nxis:ValueOption';
  value: string;
  name?: string;
}

/** A Schema.org `PropertyValueSpecification`: one input of an action. */
export interface NxisPropertyValueSpecification {
  '@type'?: string;
  valueName: string;
  description?: string;
  valueRequired?: boolean;
  defaultValue?: string;
  valueMinLength?: number;
  valueMaxLength?: number;
  minValue?: number;
  maxValue?: number;
  stepValue?: number;
  valuePattern?: string;
  multipleValues?: boolean;
  readonlyValue?: boolean;
  'nxis:valueType'?: NxisValueType;
  'nxis:valueOption'?: NxisValueOption[];
}

/** How an action is submitted: its URL, method and encoding. */
export interface NxisEntryPoint {
  '@type'?: 'EntryPoint';
  httpMethod: string;
  urlTemplate?: string;
  encodingType?: string;
  'nxis:targetKind'?: 'selfPage' | 'clientSide';
  'nxis:pageUrl'?: string;
  'nxis:jsHandled'?: boolean;
  /** Where the form itself submits, as the crawler saw it: a GET form's results page, with its fields templated. */
  'nxis:observedUrl'?: string;
}

/** A Schema.org action extracted from a page's JSON-LD. */
export interface NxisAction {
  '@context'?: unknown;
  '@type': string;
  '@id': string;
  name: string;
  description?: string;
  target: NxisEntryPoint;
  input?: NxisPropertyValueSpecification[];
  /**
   * The page's own constants: hidden fields its form submits as they are, such as which event a pass form is
   * for. Not parameters, since nobody fills them; they say which page's form an action is.
   */
  'nxis:fixedInput'?: NxisPropertyValueSpecification[];
  'nxis:extractedAt'?: string;
}
