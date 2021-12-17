/* eslint-disable import/no-named-as-default-member */
import { capitalCase, paramCase } from 'change-case'
import {
  FieldDefinitionNode,
  GraphQLSchema,
  IntValueNode,
  isEnumType,
  isObjectType,
  isUnionType,
  ListValueNode,
  ObjectTypeDefinitionNode,
  StringValueNode,
  TypeDefinitionNode,
  TypeNode,
  UnionTypeDefinitionNode,
} from 'graphql'
import {
  combinations,
  findDirective,
  findDirectiveValue,
  hasDirective,
  ifNotEmpty,
  maybeToNumber,
  switchArray,
} from '../lib/util'
import { typeName } from './graphql-ast'
import {
  AmplienceContentType,
  AmplienceContentTypeSettings,
  AmpliencePropertyType,
  GeneratorConfig,
} from './types'

export const contentTypeSchema = (
  type: TypeDefinitionNode,
  validationLevel: 'CONTENT_TYPE' | 'PARTIAL' | 'SLOT',
  { schemaHost }: GeneratorConfig
): AmplienceContentType => ({
  body: `./schemas/${paramCase(type.name.value)}-schema.json`,
  schemaId: typeUri(type, schemaHost),
  validationLevel,
})

export const contentType = (
  type: TypeDefinitionNode,
  icon = 'https://bigcontent.io/cms/icons/ca-types-primitives.png',
  { schemaHost, visualizations }: GeneratorConfig
): AmplienceContentTypeSettings => ({
  contentTypeUri: typeUri(type, schemaHost),
  status: 'ACTIVE',
  settings: {
    label: capitalCase(type.name.value),
    icons: [
      {
        size: 256,
        url: icon,
      },
    ],
    visualizations,
    cards: [],
  },
})

/**
 * Returns the properties that go inside Amplience `{type: 'object', properties: ...}`
 */
export const objectProperties = (
  type: ObjectTypeDefinitionNode,
  schema: GraphQLSchema,
  schemaHost: string
): { [name: string]: AmpliencePropertyType } =>
  Object.fromEntries(
    type.fields
      // Children can not be available as a field on the object itself
      ?.filter(prop =>
        ['children', 'ignoreAmplience'].every(term => !hasDirective(prop, term))
      )
      .map(prop => [
        prop.name.value,
        {
          title: capitalCase(prop.name.value),
          description: prop.description?.value,
          ...switchArray<AmpliencePropertyType>(prop.type, {
            ifArray: subType => ({
              type: 'array',
              minItems: maybeToNumber(
                findDirectiveValue<IntValueNode>(prop, 'list', 'minItems')
                  ?.value
              ),
              maxItems: maybeToNumber(
                findDirectiveValue<IntValueNode>(prop, 'list', 'maxItems')
                  ?.value
              ),
              items: ampliencePropertyType(prop, subType, schema, schemaHost),
              const: arrayConstValues(prop),
            }),
            other: type =>
              ampliencePropertyType(prop, type, schema, schemaHost),
          }),
        },
      ]) ?? []
  )

const arrayConstValues = (prop: FieldDefinitionNode) =>
  findDirectiveValue<ListValueNode>(prop, 'const', 'items')?.values.map(
    v => (v as StringValueNode)?.value
  )

/**
 * Returns an Amplience type object of various types (number/string/object)
 */
export const ampliencePropertyType = (
  prop: FieldDefinitionNode,
  type: TypeNode,
  schema: GraphQLSchema,
  schemaHost: string
): AmpliencePropertyType => {
  const node = schema.getType(typeName(type))

  if (node) {
    if (isUnionType(node) && node.astNode) {
      return contentLink(node.astNode, schemaHost)
    }
    if (isEnumType(node) && node.astNode) {
      return {
        type: 'string',
        enum: node.astNode.values?.map(v => v.name.value),
      }
    }
    if (isObjectType(node) && node.astNode) {
      if (hasDirective(prop, 'link')) {
        return contentLink(node.astNode, schemaHost)
      }
      return inlineObject(node.astNode, schema, schemaHost)
    }
  }

  switch (typeName(type)) {
    case 'String':
      const constTag = findDirective(prop, 'const')
      if (constTag) {
        const constValue = (constTag.arguments?.find(
          t => t.name.value === 'item'
        )?.value as StringValueNode)?.value
        return {
          type: 'string',
          const: constValue,
        }
      }
      return checkLocalized(prop, type, {
        type: 'string',
        format: findDirectiveValue<StringValueNode>(prop, 'text', 'format')
          ?.value,
        minLength: maybeToNumber(
          findDirectiveValue<IntValueNode>(prop, 'text', 'minLength')?.value
        ),
        maxLength: maybeToNumber(
          findDirectiveValue<IntValueNode>(prop, 'text', 'maxLength')?.value
        ),
        examples: findDirectiveValue<ListValueNode>(
          prop,
          'example',
          'items'
        )?.values.map(v => (v as StringValueNode)?.value),
      })
    case 'Boolean':
      return checkLocalized(prop, type, { type: 'boolean' })
    case 'Int':
    case 'Float':
      return checkLocalized(prop, type, {
        type: typeName(type) === 'Float' ? 'number' : 'integer',
        minimum: maybeToNumber(
          findDirectiveValue<IntValueNode>(prop, 'number', 'minimum')?.value
        ),
        maximum: maybeToNumber(
          findDirectiveValue<IntValueNode>(prop, 'number', 'maximum')?.value
        ),
      })
    case 'AmplienceImage':
    case 'AmplienceVideo':
      return hasDirective(prop, 'localized')
        ? refType(
            AMPLIENCE_TYPE.LOCALIZED[
              typeName(type) as 'AmplienceImage' | 'AmplienceVideo'
            ]
          )
        : refType(
            AMPLIENCE_TYPE.CORE[
              typeName(type) as 'AmplienceImage' | 'AmplienceVideo'
            ]
          )
  }
  return {}
}

// const contentReference = (
//   type: TypeDefinitionNodeReference,
//   schemaHost: string
// ) =>
//   refType(
//     AMPLIENCE_TYPE.CORE.ContentReference,
//     enumProperties(type.typeArguments![0], schemaHost)
//   )

const contentLink = (
  type: UnionTypeDefinitionNode | ObjectTypeDefinitionNode,
  schemaHost: string
) => refType(AMPLIENCE_TYPE.CORE.ContentLink, enumProperties(type, schemaHost))

// const inlineContentLink = (
//   type: TypeDefinitionNodeReference,
//   schemaHost: string
// ) => ({
//   type: 'object',
//   ...refType(typeUri(type, schemaHost)),
// })

const inlineObject = (
  type: ObjectTypeDefinitionNode,
  schema: GraphQLSchema,
  schemaHost: string
) => ({
  type: 'object',
  properties: objectProperties(type, schema, schemaHost),
  propertyOrder: type.fields?.map(n => n.name.value),
  required: type.fields
    ?.filter(field => field.type.kind === 'NonNullType')
    .map(field => field.name.value),
})

const enumProperties = (
  typeOrUnion: TypeDefinitionNode,
  schemaHost: string
) => ({
  properties: {
    contentType: {
      enum: (typeOrUnion.kind === 'UnionTypeDefinition'
        ? (((typeOrUnion.types ?? []) as unknown) as TypeDefinitionNode[])
        : [typeOrUnion]
      ).map(t => typeUri(t, schemaHost)),
    },
  },
})

/**
 * Wraps a Amplience type object in localized JSON
 */
export const checkLocalized = (
  prop: FieldDefinitionNode,
  type: TypeNode,
  result: AmpliencePropertyType
) =>
  hasDirective(prop, 'localized')
    ? prop.directives?.length === 1 && typeName(type) === 'String'
      ? refType(AMPLIENCE_TYPE.LOCALIZED.String)
      : localized(result)
    : result

export const AMPLIENCE_TYPE = {
  LOCALIZED: {
    AmplienceImage:
      'http://bigcontent.io/cms/schema/v1/localization#/definitions/localized-image',
    AmplienceVideo:
      'http://bigcontent.io/cms/schema/v1/localization#/definitions/localized-video',
    String:
      'http://bigcontent.io/cms/schema/v1/localization#/definitions/localized-string',
  },
  CORE: {
    LocalizedValue:
      'http://bigcontent.io/cms/schema/v1/core#/definitions/localized-value',
    Content: 'http://bigcontent.io/cms/schema/v1/core#/definitions/content',
    AmplienceImage:
      'http://bigcontent.io/cms/schema/v1/core#/definitions/image-link',
    AmplienceVideo:
      'http://bigcontent.io/cms/schema/v1/core#/definitions/video-link',
    ContentReference:
      'http://bigcontent.io/cms/schema/v1/core#/definitions/content-reference',
    ContentLink:
      'http://bigcontent.io/cms/schema/v1/core#/definitions/content-link',
    HierarchyNode:
      'http://bigcontent.io/cms/schema/v2/hierarchy#/definitions/hierarchy-node',
  },
}

export const refType = (ref: string, ...other: object[]) => ({
  allOf: [{ $ref: ref }, ...other],
})

export const localized = (value: AmpliencePropertyType) => ({
  ...refType(AMPLIENCE_TYPE.CORE.LocalizedValue),
  properties: {
    values: {
      items: {
        properties: {
          value,
        },
      },
    },
  },
})

export const typeUri = (type: TypeDefinitionNode, schemaHost: string) =>
  `${schemaHost}/${paramCase(type.name.value)}`

export const definitionUri = (type: TypeDefinitionNode, schemaHost: string) =>
  `${schemaHost}/${paramCase(type.name.value)}#/definitions/${paramCase(
    type.name.value
  )}`

/**
 * Returns sortable trait path for amplience based on properties containing the `@sortable` tag
 * @returns Object that can be pushed to `trait:sortable` directly
 */
export const sortableTrait = (type: ObjectTypeDefinitionNode) =>
  ifNotEmpty(
    type.fields?.filter(m => hasDirective(m, 'sortable')) ?? [],
    items => ({
      sortBy: [
        {
          key: 'default',
          paths: items.map(n => `/${n.name}`),
        },
      ],
    })
  )

/**
 * Returns hierarchy trait child content types with the current type and any other
 * types based on the `@children` tag
 * @returns Object that can be pushed to the `trait:hierarchy` directly
 */
export const hierarchyTrait = (
  type: ObjectTypeDefinitionNode,
  schemaHost: string
) => ({
  childContentTypes: [
    typeUri(type, schemaHost),
    ...(type.fields
      ?.filter(m => hasDirective(m, 'children'))
      .map(n => `${schemaHost}/${paramCase(n.name.value)}`) ?? []),
  ],
})

/**
 * Returns filterable trait path for amplience based on properties containing the `@filterable` tag.
 * Generates all possible combinations of the tags for multi-path filtering. Note Amplience only supports
 * multi-path filtering up to 5 paths.
 * @returns Object that can be pushed to `trait:filterable` directly
 */
export const filterableTrait = (type: ObjectTypeDefinitionNode) => {
  const filterableProps =
    type.fields?.filter(m => hasDirective(m, 'filterable')) ?? []
  if (filterableProps.length === 0) return undefined
  if (filterableProps.length > 5)
    throw new Error('max @filterable tags can be five')
  const filterCombinations = combinations(
    filterableProps.map(s => `/${s.name}`)
  )

  return {
    filterBy: filterCombinations.map(paths => ({ paths })),
  }
}
