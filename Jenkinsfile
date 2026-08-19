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
 *   DB_PASSWORD      the production database password, passed to compose at deploy time
 *                    so it is never written to a file on the array
 *   unraid-ssh       the key for root@unraid
 *
 * The agent needs Docker with buildx, and nothing else — no Node, no toolchain. Even the
 * typecheck and the tests run as a docker build (deploy/Dockerfile.ci). The Unraid box
 * needs docker compose (the Docker Compose Manager plugin) and a filled-in .env; both are
 * checked before anything is changed, so a missing one costs a failed deploy and nothing
 * else.
 *
 * FIRST RUN, READ THIS: the deploy stage manages the containers with compose, under the
 * same names the Unraid templates in deploy/ use (mc_web_panel and friends). Compose will
 * refuse to start if containers with those names exist but were created by the Unraid
 * Docker Manager rather than by compose. Remove them once from the Unraid UI — the data
 * lives in the appdata paths and the database, not in the containers — and every run
 * after that is unattended. Until then, run with DEPLOY unticked to publish images only.
 */

pipeline {
    agent any

    parameters {
        booleanParam(
            name: 'DEPLOY',
            defaultValue: true,
            description: 'Deploy to Unraid after publishing. Untick to build and push images only.'
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
        booleanParam(
            name: 'SKIP_TESTS',
            defaultValue: false,
            description: 'Emergency escape hatch. Publishing untested images is a choice, not a default.'
        )
    }

    environment {
        IMAGE      = 'ghcr.io/retr0777/mc-hosting'
        DEPLOY_DIR = '/mnt/user/appdata/craftcontrol'
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
                    if (!fileExists('deploy/Dockerfile.ci')) {
                        // `checkout scm` is the right call when the job has a repository
                        // attached and simply did not use it. A job defined by a pasted script
                        // has no `scm` to check out at all, and throws rather than returning
                        // anything, so the clone below is the fallback for that case.
                        try {
                            echo 'No source in the workspace — checking out the SCM attached to this job.'
                            checkout scm
                        } catch (err) {
                            echo "No SCM attached to this job (${err.message}). Cloning ${REPO_URL} at ${REPO_BRANCH} instead."
                            checkout([
                                $class: 'GitSCM',
                                branches: [[name: "*/${REPO_BRANCH}"]],
                                userRemoteConfigs: [[url: REPO_URL, credentialsId: 'github-token']],
                            ])
                        }
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

                        // Unraid does not ship compose as standard — it arrives with the
                        // Docker Compose Manager plugin. Say so here rather than letting
                        // the deploy fail on an unexplained "docker: 'compose' is not a
                        // command" three steps later.
                        sh "${ssh} 'docker compose version >/dev/null 2>&1' " +
                           "|| (echo 'docker compose is not available on ${params.UNRAID_HOST} — install the Docker Compose Manager plugin from Community Applications.' && exit 1)"

                        sh "${ssh} 'mkdir -p ${DEPLOY_DIR}'"

                        // The compose file and the tunnel config are the only things the
                        // box needs from the repo. Its .env is its own and is never touched.
                        sh """
                            scp -o StrictHostKeyChecking=no \
                                deploy/docker-compose.prod.yml deploy/frps.toml \
                                ${target}:${DEPLOY_DIR}/
                        """

                        sh "${ssh} 'test -f ${DEPLOY_DIR}/.env' " +
                           "|| (echo 'No ${DEPLOY_DIR}/.env on the host — copy deploy/env.prod.example there and fill it in.' && exit 1)"

                        withCredentials([string(credentialsId: 'DB_PASSWORD', variable: 'DB_PASSWORD')]) {
                            // set +x so the password is not echoed by the shell. Jenkins
                            // masks it in the console too; neither alone is enough.
                            sh """
                                set +x
                                ${ssh} "cd ${DEPLOY_DIR} \
                                    && DB_PASSWORD='\$DB_PASSWORD' docker compose -f docker-compose.prod.yml pull \
                                    && DB_PASSWORD='\$DB_PASSWORD' docker compose -f docker-compose.prod.yml up -d --remove-orphans"
                            """
                        }

                        // Old image layers accumulate fast at five images a build, and the
                        // array is not where anyone wants to discover that.
                        sh "${ssh} 'docker image prune -f'"

                        sh "${ssh} 'cd ${DEPLOY_DIR} && docker compose -f docker-compose.prod.yml ps'"
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
                 (params.DEPLOY ? " and deployed to ${params.UNRAID_HOST}" : ' (deploy skipped)')
        }
        failure {
            echo 'Build failed — nothing was deployed. The running stack is untouched.'
        }
    }
}
