/*
 * Build, test, publish, deploy.
 *
 * The pipeline does the work the Unraid box should not have to: it checks out, installs,
 * typechecks, tests, builds every image and pushes them to ghcr.io. The box only ever
 * pulls. That keeps deployment down to one thing that can fail — a pull — and means a
 * broken commit is caught here rather than by whoever tries to log in afterwards.
 *
 * Credentials it expects, by the ids already configured in Jenkins:
 *   github-token     ghcr.io login (username + personal access token, packages:write)
 *   docker-hub-creds Docker Hub login, purely to lift the anonymous pull rate limit on
 *                    the base images. Nothing is pushed there.
 *   unraid-ssh       the key for root@unraid
 *
 * No database password is needed any more: the containers keep the environment they were
 * created with, so nothing here has to know what is in it.
 *
 * The agent needs Docker with buildx, and nothing else — no Node, no toolchain. Even the
 * typecheck and the tests run as a docker build (deploy/Dockerfile.ci). Buildx is
 * installed on the agent by the Prepare stage if it is not already there.
 *
 * The box needs nothing installed. The deploy pulls the new images and recreates the
 * containers named by the CONTAINERS parameter against them, keeping the configuration
 * each one already has — so the Unraid templates remain the single description of how a
 * container is run, and no container is ever deleted. deploy/docker-compose.prod.yml is
 * kept for anyone running this stack somewhere other than that box; this pipeline does
 * not use it.
 *
 * Recreating the daemon restarts it, which stops any game server it is running. Deploy
 * when nobody is playing.
 */

pipeline {
    agent any

    parameters {
        booleanParam(
            name: 'DEPLOY',
            defaultValue: false,
            description: 'Deploy to Unraid after publishing. OFF by default: the deploy step removed three ' +
                         'containers and failed to recreate them once already, and until that is understood ' +
                         'publishing images is the part of this pipeline that is safe to run unattended.'
        )
        string(
            name: 'UNRAID_HOST',
            defaultValue: '192.168.50.220',
            description: 'Host to deploy to, over SSH as root.'
        )
        string(
            name: 'PLATFORMS',
            defaultValue: 'linux/amd64',
            description: 'Image platforms. Unraid is amd64; widen to linux/amd64,linux/arm64 for ARM nodes, at the cost of a much slower build.'
        )
        string(
            name: 'CONTAINERS',
            defaultValue: 'CraftControl-WebPanel,craftcontrol-daemon,craftcontrol-discord-bot',
            description: 'Containers to recreate on the newly published images, by their names on the box. ' +
                         'These are the Unraid template names, not the compose ones. Leave out anything ' +
                         'running an image this pipeline does not build — the FRP server runs a pinned ' +
                         'upstream frps and has nothing to pick up from a build.'
        )
        booleanParam(
            name: 'SKIP_TESTS',
            defaultValue: false,
            description: 'Emergency escape hatch. Publishing untested images is a choice, not a default.'
        )
    }

    environment {
        IMAGE      = 'ghcr.io/retr0777/mc-hosting'
        // Used only when the job itself has no repository attached — see the Prepare stage.
        REPO_URL    = 'https://github.com/ReTr0777/MC-hosting.git'
        REPO_BRANCH = 'main'
        // Tagged with the build number as well as the plain tag, so a bad deploy has
        // something specific to roll back to rather than "whatever :web used to be".
        BUILD_TAG_SUFFIX = "b${env.BUILD_NUMBER}"
    }

    options {
        timestamps()
        timeout(time: 60, unit: 'MINUTES')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '30'))
    }

    stages {
        stage('Prepare') {
            steps {
                // The workspace arrives empty: this job hands over the Jenkinsfile without
                // checking the repository out beside it, so there is no source for anything
                // here to build. An explicit checkout costs nothing when the job already did
                // one, and is the difference between a working pipeline and "lstat deploy: no
                // such file or directory" when it did not.
                script {
                    // Unconditionally, every build. Guarding this on the workspace being empty
                    // meant the first build cloned and every build after it silently reused
                    // that same commit — five images were published from a revision three
                    // commits stale before the `Building <sha>` line below gave it away.
                    //
                    // `checkout scm` is the right call when the job has a repository attached.
                    // A job defined by a pasted script has no `scm` to check out at all and
                    // throws rather than returning anything, so the clone is the fallback.
                    try {
                        checkout scm
                    } catch (err) {
                        echo "No SCM attached to this job (${err.message}). Cloning ${REPO_URL} at ${REPO_BRANCH} instead."
                        checkout([
                            $class: 'GitSCM',
                            branches: [[name: "*/${REPO_BRANCH}"]],
                            userRemoteConfigs: [[url: REPO_URL, credentialsId: 'github-token']],
                        ])
                    }
                    if (!fileExists('deploy/Dockerfile.ci')) {
                        error 'Still no deploy/Dockerfile.ci after checking out. The workspace is ' +
                              'not the root of this repository — check the branch and the repo URL.'
                    }
                    echo "Building ${sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()}."
                }

                // Jenkins ships a plain docker CLI with no plugins, so buildx has to be put
                // there. It goes in $HOME/.docker/cli-plugins, which on this agent is inside
                // /var/jenkins_home and therefore survives the build — the download happens
                // once, and every run after this one finds it already in place.
                //
                // The tag comes from the redirect on /releases/latest rather than the API,
                // which rate-limits unauthenticated callers and would fail a build for no
                // reason it could explain. The pin is only the fallback for a GitHub that is
                // not answering; bump it whenever, nothing depends on it being current.
                sh '''
                    set -e
                    if docker buildx version >/dev/null 2>&1; then
                        echo "buildx already present: $(docker buildx version)"
                        exit 0
                    fi

                    case "$(uname -m)" in
                        x86_64)  arch=amd64 ;;
                        aarch64) arch=arm64 ;;
                        *) echo "no buildx build published for $(uname -m)" >&2; exit 1 ;;
                    esac

                    latest=https://github.com/docker/buildx/releases/latest
                    tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$latest" 2>/dev/null | sed 's#.*/tag/##')
                    case "$tag" in
                        v*) ;;
                        *) tag=v0.17.1; echo "could not resolve the latest buildx; falling back to $tag" ;;
                    esac

                    echo "Installing buildx $tag for linux/$arch..."
                    mkdir -p "$HOME/.docker/cli-plugins"
                    asset="https://github.com/docker/buildx/releases/download/$tag/buildx-$tag.linux-$arch"
                    curl -fsSL -o "$HOME/.docker/cli-plugins/docker-buildx" "$asset"
                    chmod +x "$HOME/.docker/cli-plugins/docker-buildx"
                    docker buildx version
                '''

                // The container driver, needed for the registry cache the publish stage
                // uses and for building without exporting an image in the verify stage.
                // Created here so both get the same builder.
                sh 'docker buildx create --name craftcontrol --use 2>/dev/null || docker buildx use craftcontrol'

                // Logged in before anything pulls. Every Dockerfile here starts FROM an
                // image on Docker Hub — the verify stage included — and the anonymous
                // rate limit runs out partway through a six-image run.
                withCredentials([usernamePassword(
                    credentialsId: 'docker-hub-creds',
                    usernameVariable: 'DH_USER',
                    passwordVariable: 'DH_PASS'
                )]) {
                    sh 'set +x; echo "$DH_PASS" | docker login -u "$DH_USER" --password-stdin'
                }
            }
        }

        stage('Verify') {
            when { expression { !params.SKIP_TESTS } }
            steps {
                // Typecheck and tests run as a docker build rather than on the agent, which
                // has Docker but no Node — see deploy/Dockerfile.ci for why it is done this
                // way round rather than by installing a toolchain on the controller.
                //
                // No tag and no --load: nothing is kept, so buildx never spends the minute
                // it takes to export an image that exists only to have passed.
                sh "docker buildx build --file deploy/Dockerfile.ci --progress plain ."
            }
        }

        stage('Publish images') {
            steps {
                script {
                    withCredentials([usernamePassword(
                        credentialsId: 'github-token',
                        usernameVariable: 'GH_USER',
                        passwordVariable: 'GH_TOKEN'
                    )]) {
                        sh 'set +x; echo "$GH_TOKEN" | docker login ghcr.io -u "$GH_USER" --password-stdin'
                    }

                    [
                        ['web',         'apps/web/Dockerfile'],
                        ['daemon',      'apps/daemon/Dockerfile'],
                        ['proxy',       'apps/proxy/Dockerfile'],
                        ['nanolimbo',   'apps/nanolimbo/Dockerfile'],
                        ['discord-bot', 'apps/discord-bot/Dockerfile'],
                    ].each { entry ->
                        // Indexed rather than destructured in the closure signature: Jenkins
                        // runs this through its CPS interpreter, which hands a one-element
                        // list the whole pair as the first parameter and leaves the second
                        // null. That produced `--file null` and an image tagged with the
                        // literal text of the pair.
                        def name = entry[0]
                        def dockerfile = entry[1]
                        sh """
                            docker buildx build \
                                --platform '${params.PLATFORMS}' \
                                --file '${dockerfile}' \
                                --tag '${IMAGE}:${name}' \
                                --tag '${IMAGE}:${name}-${BUILD_TAG_SUFFIX}' \
                                --cache-from 'type=registry,ref=${IMAGE}:${name}-cache' \
                                --cache-to 'type=registry,ref=${IMAGE}:${name}-cache,mode=max' \
                                --push \
                                .
                        """
                    }
                }
            }
        }

        stage('Deploy to Unraid') {
            when { expression { params.DEPLOY } }
            steps {
                sshagent(credentials: ['unraid-ssh']) {
                    script {
                        def target = "root@${params.UNRAID_HOST}"
                        def ssh = "ssh -o StrictHostKeyChecking=no ${target}"
                        def names = params.CONTAINERS.split(',').collect { it.trim() }.findAll { it }

                        if (!names) {
                            error 'CONTAINERS is empty — nothing to deploy to.'
                        }

                        // Pull on the host rather than letting watchtower do it. The host is
                        // already able to pull these; watchtower would need its own registry
                        // credentials, and giving a throwaway container the ghcr token to
                        // repeat a job docker has just done is not worth the extra secret.
                        // It runs with --no-pull below for exactly this reason.
                        ['web', 'daemon', 'proxy', 'nanolimbo', 'discord-bot'].each { name ->
                            sh "${ssh} 'docker pull ${IMAGE}:${name}'"
                        }

                        /*
                         * Recreate each container on the image just pulled, keeping the
                         * configuration it already has.
                         *
                         * The alternative is writing every port, mount and environment
                         * variable of every container into this file, where it would be a
                         * second copy of what the Unraid templates already hold — and the
                         * copy that silently goes stale. Watchtower reads the running
                         * container's own config and recreates it against the new image, so
                         * the template stays the one description of how a container is run.
                         *
                         * Only containers that are running are considered. One deliberately
                         * stopped is left stopped rather than revived by a deploy.
                         */
                        def targets = names.join(' ')
                        error """Refusing to recreate ${targets}.

                            |This step ran watchtower to recreate these containers against the newly pulled
                            |images. It removed them and did not create the replacements, leaving the box with
                            |no panel, no daemon and no bot until they were rebuilt from their Unraid templates.
                            |
                            |Recreating a container is deleting it and making another one, and there is no
                            |version of that which is safe when the only description of how to make the new one
                            |lives inside the container being deleted. Restore this only with something that
                            |reads the configuration from a source that outlives the container — the templates
                            |in /boot/config/plugins/dockerMan/templates-user, or a compose file.
                            |
                            |Publish images with DEPLOY off and update the containers from the Unraid Docker
                            |tab until then.""".stripMargin()

                        // Old image layers accumulate fast at five images a build, and the
                        // array is not where anyone wants to discover that.
                        sh "${ssh} 'docker image prune -f'"

                        sh "${ssh} 'docker ps --filter name=${names[0]} " +
                           names.tail().collect { "--filter name=${it} " }.join('') +
                           "--format \"table {{.Names}}\t{{.Image}}\t{{.Status}}\"'"
                    }
                }
            }
        }
    }

    post {
        always {
            sh 'docker logout ghcr.io || true'
            sh 'docker logout || true'
        }
        success {
            echo "Published ${IMAGE}:*-${BUILD_TAG_SUFFIX}" +
                 (params.DEPLOY ? " and recreated ${params.CONTAINERS} on ${params.UNRAID_HOST}" : ' (deploy skipped)')
        }
        failure {
            echo 'Build failed — nothing was deployed. The running stack is untouched.'
        }
    }
}
