import type { File, Identifier } from "@babel/types";
import type Graph from "graphology";

import { join } from "node:path";

import generate from "@babel/generator";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import {
  assignmentExpression,
  awaitExpression,
  callExpression,
  exportDefaultDeclaration,
  exportNamedDeclaration,
  exportSpecifier,
  file,
  identifier,
  importDeclaration,
  importExpression,
  importNamespaceSpecifier,
  importSpecifier,
  isArrowFunctionExpression,
  isBlockStatement,
  isCallExpression,
  isExpressionStatement,
  isFunctionExpression,
  isIdentifier,
  isMemberExpression,
  isNumericLiteral,
  isObjectExpression,
  isObjectProperty,
  isReturnStatement,
  isSequenceExpression,
  memberExpression,
  program,
  stringLiteral,
  variableDeclaration,
  variableDeclarator,
} from "@babel/types";
import consola from "consola";
import { format } from "prettier";
import reserved from "reserved";

import prettierConfig from "../.prettierrc.json";
import { getDefaultExport, parseImportCall } from "./ast";

export interface WebpackChunk {
  chunkId: number;
  chunkModules: Record<number, WebpackChunkModule>;
}

export interface WebpackChunkModule {
  file: File;
  source: string;

  isCommonJS: boolean;
  importedModules: string[];
}

export interface ModuleTransformations {
  renameModule?: string;
  renameVariables?: Record<number, string>;
}

export interface WebpackChunkModuleTransformations {
  [moduleId: string]: ModuleTransformations;
}

function resolveModule(
  moduleId: string | number,
  moduleTransformations?: WebpackChunkModuleTransformations,
) {
  const moduleTransformation = moduleTransformations?.[moduleId];

  if (moduleTransformation?.renameModule) {
    return moduleTransformation.renameModule;
  }

  return moduleId.toString();
}

export async function splitWebpackChunk(
  webpackChunkSrc: string,
  {
    esmDefaultExports = true,
    includeVariableDeclarationComments,
    includeVariableReferenceComments,
    moduleTransformations,
    graph,
    write,
  }: {
    esmDefaultExports?: boolean;

    includeVariableDeclarationComments?: boolean;
    includeVariableReferenceComments?: boolean;

    moduleTransformations?: WebpackChunkModuleTransformations;

    graph?: Graph | null;

    write: false | string;
  },
): Promise<WebpackChunk | null> {
  const m = webpackChunkSrc.match(
    /(\((self\.webpackChunk(\w*))=\2\|\|\[\]\)\.push\()\[\[(\d+)\],(\{.+\})]\);/s,
  );

  if (!m) {
    return null;
  }

  const chunkId = parseInt(m[4]);
  const chunkModulesSrc = `(${m[5]}, 0)`;

  const chunkLogger = consola.withTag(`chunk-${chunkId}`);

  const chunkModulesFilename = write
    ? join(write, `chunk-${chunkId}.js`)
    : null;
  const chunkModulesSrcFormattedPromise = write
    ? format(chunkModulesSrc, {
        parser: "babel",
        filepath: chunkModulesFilename!,
      }).then(async (chunkModulesSrcFormatted) => {
        await Bun.write(chunkModulesFilename!, chunkModulesSrcFormatted);
      })
    : null;

  const ast = parse(chunkModulesSrc);

  if (ast.program.body.length !== 1) {
    return null;
  }

  const rootExpressionStatement = ast.program.body[0];

  if (!isExpressionStatement(rootExpressionStatement)) {
    return null;
  }

  const rootSequenceExpression = rootExpressionStatement.expression;

  if (!isSequenceExpression(rootSequenceExpression)) {
    return null;
  }

  const rootObjectExpression = rootSequenceExpression.expressions[0];

  if (!isObjectExpression(rootObjectExpression)) {
    return null;
  }

  const chunkModules: Record<number | string, WebpackChunkModule> = {};

  let chunkModuleParams: string[] = [];

  chunkModulesLoop: for (const property of rootObjectExpression.properties) {
    if (!isObjectProperty(property)) {
      chunkLogger.warn(
        "Chunk module is not an object property:",
        property.type,
      );
      continue;
    }

    if (!isNumericLiteral(property.key)) {
      if (isIdentifier(property.key)) {
        const fusionModuleMatch = property.key.name.match(/^__fusion__(\d+)$/);

        if (fusionModuleMatch) {
          const fusionModuleId = parseInt(fusionModuleMatch[1]);

          const moduleLogger = chunkLogger.withTag(
            `fusion-module-${fusionModuleId}`,
          );

          // TODO
          moduleLogger.warn(`Fusion modules not implemented`);
          continue;
        }
      }

      chunkLogger.warn("Invalid chunk module key:", property.key.type);
      continue;
    }

    const moduleId = resolveModule(property.key.value, moduleTransformations);

    const moduleLogger = chunkLogger.withTag(`module-${moduleId}`);

    graph?.mergeNode(moduleId, { chunkId });

    if (
      !isFunctionExpression(property.value) &&
      !isArrowFunctionExpression(property.value)
    ) {
      moduleLogger.warn("Invalid chunk module value:", property.value.type);
      continue;
    }

    const moduleFunction = property.value;

    if (moduleFunction.params.length > 3) {
      moduleLogger.warn(
        "Too many chunk module function params:",
        moduleFunction.params.length,
      );
      continue;
    }

    for (let i = 0; i < moduleFunction.params.length; i++) {
      const param = moduleFunction.params[i];

      if (!isIdentifier(param)) {
        moduleLogger.warn("Invalid chunk module function param:", param.type);
        continue chunkModulesLoop;
      }

      if (chunkModuleParams[i]) {
        if (chunkModuleParams[i] !== param.name) {
          moduleLogger.warn("Invalid chunk module function param:", param.name);
          continue chunkModulesLoop;
        }
      } else {
        chunkModuleParams[i] = param.name;
      }
    }

    if (!isBlockStatement(moduleFunction.body)) {
      moduleLogger.warn(
        "Invalid chunk module function body:",
        moduleFunction.body.type,
      );
      continue;
    }

    const moduleFile = file(program(moduleFunction.body.body));

    const importedModules: string[] = [];

    let moduleIsCommonJS = false;
    let moduleHasDefaultExport = false;

    traverse(moduleFile, {
      AssignmentExpression(path) {
        const defaultExport = getDefaultExport(
          moduleLogger,
          path,
          chunkModuleParams,
        );

        if (!defaultExport) {
          return;
        }

        if (moduleHasDefaultExport) {
          moduleLogger.log("Multiple default exports found, assuming CommonJS");
          moduleIsCommonJS = true;
          path.stop();
        } else if (isObjectExpression(defaultExport)) {
          moduleLogger.log("Default export is an object, assuming CommonJS");
          moduleIsCommonJS = true;
          path.stop();
        }

        moduleHasDefaultExport = true;
      },
    });

    if (moduleIsCommonJS) {
      graph?.mergeNode(moduleId, { type: "square" });
    }

    traverse(moduleFile, {
      CallExpression(path) {
        if (isMemberExpression(path.node.callee)) {
          if (isIdentifier(path.node.callee.object)) {
            if (path.node.callee.object.name === chunkModuleParams[2]) {
              if (isIdentifier(path.node.callee.property)) {
                if (path.node.callee.property.name === "d") {
                  if (path.node.arguments.length !== 2) {
                    moduleLogger.warn(
                      "Invalid export arguments:",
                      path.node.arguments.length,
                    );
                    return;
                  }

                  if (
                    !isIdentifier(path.node.arguments[0]) ||
                    path.node.arguments[0].name !== chunkModuleParams[1]
                  ) {
                    moduleLogger.warn(
                      "Invalid export first argument:",
                      path.node.arguments[0].type,
                    );
                    return;
                  }

                  if (!isObjectExpression(path.node.arguments[1])) {
                    moduleLogger.warn(
                      "Invalid exports:",
                      path.node.arguments[1].type,
                    );
                    return;
                  }

                  for (const property of path.node.arguments[1].properties) {
                    if (!isObjectProperty(property)) {
                      moduleLogger.warn("Invalid export:", property.type);
                      continue;
                    }

                    if (!isIdentifier(property.key)) {
                      moduleLogger.warn(
                        "Invalid export property key:",
                        property.key.type,
                      );
                      continue;
                    }

                    if (
                      !isFunctionExpression(property.value) &&
                      !isArrowFunctionExpression(property.value)
                    ) {
                      moduleLogger.warn(
                        "Invalid export property value:",
                        property.value.type,
                      );
                      continue;
                    }

                    if (property.value.params.length) {
                      moduleLogger.warn(
                        "Invalid export property value params:",
                        property.value.params.length,
                      );
                      continue;
                    }

                    let exportedVar: string | null = null;

                    if (isBlockStatement(property.value.body)) {
                      if (property.value.body.body.length === 1) {
                        if (!isReturnStatement(property.value.body.body[0])) {
                          moduleLogger.warn(
                            "Invalid export property value body:",
                            property.value.body.body[0].type,
                          );
                          continue;
                        }

                        if (!property.value.body.body[0].argument) {
                          // TODO: void export
                          moduleLogger.warn("Void exports not implemented");
                          continue;
                        }

                        if (
                          !isIdentifier(property.value.body.body[0].argument)
                        ) {
                          moduleLogger.warn(
                            "Invalid export property value body:",
                            property.value.body.body[0].argument.type,
                          );
                          continue;
                        }

                        exportedVar = property.value.body.body[0].argument.name;
                      } else if (property.value.body.body.length) {
                        moduleLogger.warn(
                          "Invalid export property value body:",
                          property.value.body.body.length,
                        );
                        continue;
                      }

                      // TODO: void export
                      moduleLogger.warn("Void exports not implemented");
                    } else if (isIdentifier(property.value.body)) {
                      exportedVar = property.value.body.name;
                    } else {
                      moduleLogger.warn(
                        "Invalid export property value body:",
                        property.value.body.type,
                      );
                      continue;
                    }

                    if (exportedVar) {
                      const statementParent = path.getStatementParent();

                      if (!statementParent) {
                        moduleLogger.warn(
                          "No statement parent for export found",
                        );
                        continue;
                      }

                      const exportAs = property.key.name;

                      moduleLogger.log(
                        "Rewriting export",
                        exportedVar.padEnd(5),
                        "as",
                        exportAs,
                      );

                      if (exportAs === "default") {
                        statementParent.insertBefore(
                          exportDefaultDeclaration(identifier(exportedVar)),
                        );
                      } else {
                        statementParent.insertBefore(
                          exportNamedDeclaration(null, [
                            exportSpecifier(
                              identifier(exportedVar),
                              identifier(exportAs),
                            ),
                          ]),
                        );
                      }
                    }
                  }

                  path.remove();
                }
              }
            }
          }
        } else {
          const importRawModuleId = parseImportCall(
            moduleLogger,
            path.node,
            path.scope,
            chunkModuleParams,
          );

          if (importRawModuleId === null) {
            return;
          }

          const importModuleId = resolveModule(
            importRawModuleId,
            moduleTransformations,
          );

          importedModules.push(importModuleId);
          graph?.mergeNode(importModuleId);
          graph?.addEdge(moduleId, importModuleId);

          // TODO: check if await is allowed in scope

          let useRequire = moduleIsCommonJS;

          if (!moduleIsCommonJS) {
            const functionParent = path.getFunctionParent();

            if (functionParent?.node.async === false) {
              // If the parent function is not async, we cannot use await
              useRequire = true;
            }
          }

          if (useRequire) {
            moduleLogger.log("Rewriting import call as require");

            path.replaceWith(
              callExpression(identifier("require"), [
                stringLiteral(`./${importModuleId}`),
              ]),
            );

            return;
          }

          moduleLogger.log("Rewriting import call");

          path.replaceWith(
            awaitExpression(
              importExpression(stringLiteral(`./${importModuleId}`)),
            ),
          );
        }
      },
      VariableDeclarator(path) {
        if (isCallExpression(path.node.init)) {
          const importRawModuleId = parseImportCall(
            moduleLogger,
            path.node.init,
            path.scope,
            chunkModuleParams,
          );

          if (importRawModuleId === null) {
            return;
          }

          const importModuleId = resolveModule(
            importRawModuleId,
            moduleTransformations,
          );

          importedModules.push(importModuleId);
          graph?.mergeNode(importModuleId);
          graph?.addEdge(moduleId, importModuleId);

          if (moduleIsCommonJS) {
            moduleLogger.log("Rewriting import call as require");

            path.replaceWith(
              variableDeclarator(
                path.node.id,
                callExpression(identifier("require"), [
                  stringLiteral(`./${importModuleId}`),
                ]),
              ),
            );

            return;
          }

          if (!isIdentifier(path.node.id)) {
            moduleLogger.warn(
              "Non-identifier imports are not implemented, got:",
              path.node.id.type,
            );
            return;
          }

          const statementParent = path.getStatementParent();

          if (!statementParent) {
            moduleLogger.warn("No statement parent for import found");
            return;
          }

          statementParent.insertBefore(
            importDeclaration(
              [importNamespaceSpecifier(identifier(path.node.id.name))],
              stringLiteral(`./${importModuleId}`),
            ),
          );
          path.remove();
        } else if (isMemberExpression(path.node.init)) {
          if (isCallExpression(path.node.init.object)) {
            const importRawModuleId = parseImportCall(
              moduleLogger,
              path.node.init.object,
              path.scope,
              chunkModuleParams,
            );

            if (importRawModuleId === null) {
              return;
            }

            const importModuleId = resolveModule(
              importRawModuleId,
              moduleTransformations,
            );

            importedModules.push(importModuleId);
            graph?.mergeNode(importModuleId);
            graph?.addEdge(moduleId, importModuleId);

            if (!isIdentifier(path.node.id)) {
              moduleLogger.warn(
                "Non-identifier imports are not implemented, got:",
                path.node.id.type,
              );
              return;
            }

            if (!isIdentifier(path.node.init.property)) {
              moduleLogger.warn(
                "Non-identifier import accessors are not implemented, got:",
                path.node.init.property.type,
              );
              return;
            }

            const statementParent = path.getStatementParent();

            if (!statementParent) {
              moduleLogger.warn("No statement parent for import found");
              return;
            }

            statementParent.insertBefore(
              importDeclaration(
                [importSpecifier(path.node.id, path.node.init.property)],
                stringLiteral(`./${importModuleId}`),
              ),
            );
            path.remove();
          }
        }
      },
      AssignmentExpression(path) {
        const defaultExport = getDefaultExport(
          moduleLogger,
          path,
          chunkModuleParams,
        );

        if (!defaultExport) {
          return;
        }

        if (moduleIsCommonJS || !esmDefaultExports) {
          moduleLogger.log("Rewriting default exports as CommonJS");

          path.replaceWith(
            assignmentExpression(
              "=",
              memberExpression(identifier("module"), identifier("exports")),
              defaultExport,
            ),
          );

          return;
        }

        moduleLogger.log("Rewriting default exports");

        if (isExpressionStatement(path.parent)) {
          path.parentPath.replaceWith(exportDefaultDeclaration(defaultExport));
        } else {
          const statementParent = path.getStatementParent();

          if (!statementParent) {
            moduleLogger.warn("No statement parent for default exports found");
            return;
          }

          const exportsId = path.scope.generateUidIdentifier("exports");
          statementParent.insertBefore(
            variableDeclaration("const", [
              variableDeclarator(exportsId, defaultExport),
            ]),
          );
          statementParent.insertBefore(exportDefaultDeclaration(exportsId));

          path.replaceWith(exportsId);
        }
      },
      ImportSpecifier(path) {
        if (!isIdentifier(path.node.imported)) {
          moduleLogger.warn(
            "Non-identifier imports should be unreachable, got:",
            path.node.imported.type,
          );
          return;
        }

        if (path.node.local.name === path.node.imported.name) {
          return;
        }

        let renameTo = path.node.imported.name;

        if (reserved.includes(renameTo)) {
          renameTo = `_${renameTo}`;
        }

        if (path.scope.hasBinding(renameTo)) {
          moduleLogger.warn(
            "Cannot rename local to match import,",
            renameTo,
            "is already bound",
          );
          return;
        }

        path.scope.rename(path.node.local.name, renameTo);

        moduleLogger.log(
          "Renamed local",
          path.node.local.name,
          "to match import:",
          renameTo,
        );
      },
      ExportSpecifier(path) {
        if (!isIdentifier(path.node.exported)) {
          moduleLogger.warn(
            "Non-identifier exports should be unreachable, got:",
            path.node.exported.type,
          );
          return;
        }

        if (path.node.local.name === path.node.exported.name) {
          return;
        }

        let renameTo = path.node.exported.name;

        if (reserved.includes(renameTo)) {
          renameTo = `_${renameTo}`;
        }

        if (path.scope.hasBinding(renameTo)) {
          moduleLogger.warn(
            "Cannot rename local to match export,",
            renameTo,
            "is already bound",
          );
          return;
        }

        path.scope.rename(path.node.local.name, renameTo);

        moduleLogger.log(
          "Renamed local",
          path.node.local.name,
          "to match export:",
          renameTo,
        );
      },
    });

    const moduleVariables = new WeakMap<Identifier, number>();
    let moduleVariableCount = 0;

    if (
      includeVariableDeclarationComments ||
      includeVariableReferenceComments
    ) {
      traverse(moduleFile, {
        Identifier(path) {
          const binding = path.scope.getBinding(path.node.name);

          if (!binding) {
            return;
          }

          if (binding.identifier === path.node) {
            // This is the declaration

            const variableId = moduleVariableCount;

            if (includeVariableDeclarationComments) {
              path.addComment("leading", `Variable dec ${variableId}`);
            }

            moduleVariables.set(path.node, variableId);

            let renameTo =
              moduleTransformations?.[moduleId]?.renameVariables?.[variableId];

            if (renameTo) {
              if (reserved.includes(renameTo)) {
                renameTo = `_${renameTo}`;
              }

              path.scope.rename(path.node.name, renameTo);

              consola.log(
                `Renamed variable ${path.node.name} to ${renameTo} in module ${moduleId}`,
              );
            }

            moduleVariableCount++;
          } else if (includeVariableReferenceComments) {
            // This is a reference
            const variableId = moduleVariables.get(binding.identifier);
            path.addComment("leading", `Variable ref ${variableId}`);
          }
        },
      });
    }

    const filename = write ? join(write, `${moduleId}.js`) : undefined;

    const moduleCode = generate(moduleFile, { filename }).code;

    const formattedModuleCode = await format(moduleCode, {
      parser: "babel",
      filepath: filename,

      ...prettierConfig,
    });

    chunkModules[moduleId] = {
      file: moduleFile,
      source: formattedModuleCode,

      isCommonJS: moduleIsCommonJS,
      importedModules,
    };

    if (write) {
      await Bun.write(
        filename!,
        `\
/*
 * Webpack chunk ${chunkId}, ${moduleIsCommonJS ? "CJS" : "ESM"} module ${moduleId}
 */

${formattedModuleCode}`,
      );
    }
  }

  await chunkModulesSrcFormattedPromise;

  return { chunkId, chunkModules };
}
