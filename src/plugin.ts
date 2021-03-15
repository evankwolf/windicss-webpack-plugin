import {Compiler, Options} from './interfaces'
import {createUtils, configureFiles} from '@windicss/plugin-utils'
import {relative, resolve} from 'path'
import {MODULE_ID_VIRTUAL, NAME} from './constants'
import {existsSync} from 'fs'
import VirtualModulesPlugin from 'webpack-virtual-modules'

const loadersPath = resolve(__dirname, 'loaders')
const transformCSSLoader = resolve(loadersPath, 'transform-css.js')
const transforTemplateLoader = resolve(loadersPath, 'transform-template.js')
const virtualModuleLoader = resolve(loadersPath, 'virtual-module.js')

class WindiCSSWebpackPlugin {
  options

  constructor(options: Options = {}) {
    // @todo validate options
    this.options = {
      transformCSS: true,
      transformGroups: true,
      ...options,
    } as Options
  }

  apply(compiler: Compiler): void {
    // @ts-expect-error
    const root = this.options.root ?? compiler.options.resolve.alias['~'] ?? compiler.context
    // Fix possibly undefined issues
    if (!compiler.options.module || !compiler.options.module.rules) {
      return
    }

    // setup alias
    if (compiler.options.resolve?.alias) {
      compiler.options.resolve.alias['windi.css'] = resolve(MODULE_ID_VIRTUAL)
    }

    /*
     * Transform groups within all detect targets.
     *
     * e.g. hover:(bg-teal-900 rounded-full) -> hover:bg-teal-900 hover:rounded-full
     */
    if (this.options.transformGroups) {
      compiler.options.module.rules.push({
        include(resource) {
          const relativeResource = relative(root, resource)
          return Boolean(compiler.$windyCSSService?.isDetectTarget(relativeResource))
        },
        use: [{loader: transforTemplateLoader}],
      })
    }


    /*
     * Virtual module loader
     */
    compiler.options.module.rules.push({
      include(resource) {
        return resource.endsWith(MODULE_ID_VIRTUAL)
      },
      use: [{
        ident: `${NAME}:entry`,
        loader: virtualModuleLoader
      }],
    })

    /*
     * Transform css for tailwind directives.
     *
     * e.g. @apply .pt-8 pb-6; -> .pt-8 { }; .pb-6 { };
     */
    const transformCSS = this.options.transformCSS as boolean | 'pre' | 'auto' | 'post'
    if (transformCSS === true) {
      compiler.options.module.rules.push({
        include(resource) {
          const relativeResource = relative(root, resource)
          // Exclude virtual module
          if (resource.endsWith(MODULE_ID_VIRTUAL) || compiler.$windyCSSService?.isExcluded(relativeResource)) {
            return false
          }

          return Boolean(compiler.$windyCSSService?.isCssTransformTarget(relativeResource))
        },
        use: [{
          ident: `${NAME}:css`,
          loader: transformCSSLoader
        }],
      })
    } else {
      switch (transformCSS) {
        case 'auto':
          compiler.options.module.rules.push({
            enforce: 'pre',
            include(resource) {
              const relativeResource = relative(root, resource)
              if (compiler.$windyCSSService?.isExcluded(relativeResource) || relativeResource.endsWith(MODULE_ID_VIRTUAL)) {
                return false
              }

              return Boolean(relativeResource.match(/\.(?:postcss|scss|css)(?:$|\?)/i))
            },
            use: [{
              ident: `${NAME}:css:pre`,
              loader: transformCSSLoader
            }],
          })
          compiler.options.module.rules.push({
            include(resource) {
              const relativeResource = relative(root, resource)
              if (compiler.$windyCSSService?.isExcluded(relativeResource) || resource.endsWith(MODULE_ID_VIRTUAL)) {
                return false
              }

              return Boolean(resource.match(/\.(?:sass|stylus|less)(?:$|\?)/i))
            },
            use: [{
              ident: `${NAME}:css`,
              loader: transformCSSLoader
            }],
          })
          break
        case 'pre':
        case 'post':
          compiler.options.module.rules.push({
            enforce: transformCSS,
            include(resource) {
              const relativeResource = relative(root, resource)
              return Boolean(compiler.$windyCSSService?.isCssTransformTarget(relativeResource)) && !resource.endsWith(MODULE_ID_VIRTUAL)
            },
            use: [{
              ident: `${NAME}:css`,
              loader: transformCSSLoader
            }],
          })
          break
      }
    }

    /*
    * Add the windycss config file as a dependency so that the watcher can handle updates to it.
    */
    compiler.hooks.afterCompile.tap(NAME, compilation => {
      if (compiler.$windyCSSService) {
        let hasConfig = false
        // add watcher for the config path
        for (const name of configureFiles) {
          const tryPath = resolve(root, name)
          if (existsSync(tryPath)) {
            compilation.fileDependencies.add(tryPath)
            hasConfig = true
          }
        }
        // add watcher for missing dependencies
        if (!hasConfig) {
          for (const name of configureFiles) {
            compilation.missingDependencies.add(name)
          }
        }
      }
    })

    /*
     * Triggered when the watcher notices a file is updated. We keep track of the updated (dirty) file and
     * create an invalidated on our virtual module.
     */
    let hmrId = 0
    compiler.hooks.invalid.tap(NAME, filename => {
      // make sure service is available and file is valid
      if (!compiler.$windyCSSService || !filename || filename.endsWith(MODULE_ID_VIRTUAL)) {
        return
      }
      const relativeResource = relative(root, filename)
      if (!compiler.$windyCSSService.isDetectTarget(relativeResource) && filename != compiler.$windyCSSService.configFilePath) {
        return
      }

      // Add dirty file so the loader can process it
      compiler.$windyCSSService.dirty.add(filename)
      // Trigger a change to the virtual module
      virtualModules.writeModule(
        MODULE_ID_VIRTUAL,
        // Need to write a dynamic string which will mark the file as modified
        `/* windicss(hmr:${hmrId++}:${filename}) */`
      )
    })

    const virtualModules = new VirtualModulesPlugin({
      [MODULE_ID_VIRTUAL]: '/* windicss(boot) */',
    })
    virtualModules.apply(compiler)

    let isWatchMode = false

    // Make windy service available to the loader
    const initWindyCSSService = async () => {
      if (!compiler.$windyCSSService) {
        compiler.$windyCSSService = Object.assign(
          createUtils(this.options, {
            root,
            name: NAME,
          }), {
            root,
            dirty: new Set<string>(),
          }
        )
        // Scans all files and builds initial css
        // wrap in a try catch
        try {
          compiler.$windyCSSService.init()
        } catch (e) {
          compiler.$windyCSSService.initException = e
        }
      }
    }

    compiler.hooks.thisCompilation.tap(NAME, compilation => {
      if (!compiler.$windyCSSService) {
        return
      }
      // give the init exception to the compilation so that the user can see there was an issue
      if (compiler.$windyCSSService.initException) {
        compilation.errors.push(compiler.$windyCSSService.initException)
        compiler.$windyCSSService.initException = undefined
      }
      compilation.hooks.childCompiler.tap(NAME, childCompiler => {
        childCompiler.$windyCSSService = compiler.$windyCSSService
      })
    })

    compiler.hooks.beforeCompile.tapPromise(NAME, async () => {
      await initWindyCSSService()
    })

    compiler.hooks.watchRun.tapPromise(NAME, async () => {
      isWatchMode = true
      await initWindyCSSService()
    })

    compiler.hooks.done.tap(NAME, () => {
      if (!isWatchMode && compiler.$windyCSSService) {
        compiler.$windyCSSService = undefined
      }
    })
  }
}

export default WindiCSSWebpackPlugin
