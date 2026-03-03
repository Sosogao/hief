import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import * as path from 'path';
import * as fs from 'fs';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function loadSchema(name: string): object {
  const schemaPath = path.resolve(
    __dirname,
    '../../../../schemas',
    `${name}.schema.json`
  );
  const raw = fs.readFileSync(schemaPath, 'utf-8');
  return JSON.parse(raw);
}

let intentValidator: ReturnType<typeof ajv.compile> | null = null;
let solutionValidator: ReturnType<typeof ajv.compile> | null = null;
let policyResultValidator: ReturnType<typeof ajv.compile> | null = null;

export function validateIntent(data: unknown): { valid: boolean; errors: string[] } {
  if (!intentValidator) {
    intentValidator = ajv.compile(loadSchema('intent'));
  }
  const valid = intentValidator(data) as boolean;
  return {
    valid,
    errors: intentValidator.errors?.map((e) => `${e.instancePath} ${e.message}`) ?? [],
  };
}

export function validateSolution(data: unknown): { valid: boolean; errors: string[] } {
  if (!solutionValidator) {
    solutionValidator = ajv.compile(loadSchema('solution'));
  }
  const valid = solutionValidator(data) as boolean;
  return {
    valid,
    errors: solutionValidator.errors?.map((e) => `${e.instancePath} ${e.message}`) ?? [],
  };
}

export function validatePolicyResult(data: unknown): { valid: boolean; errors: string[] } {
  if (!policyResultValidator) {
    policyResultValidator = ajv.compile(loadSchema('policy-result'));
  }
  const valid = policyResultValidator(data) as boolean;
  return {
    valid,
    errors: policyResultValidator.errors?.map((e) => `${e.instancePath} ${e.message}`) ?? [],
  };
}
