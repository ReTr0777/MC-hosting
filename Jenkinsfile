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
 * The agent needs Node 20+, npm and Docker with buildx. The Unraid box needs docker
 * compose (the Docker Compose Manager plugin) and a filled-in .env — both are checked
 * before anything is changed, so a missing one costs a failed deploy and nothing else.
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
        stage('Install') {
            steps {
                sh 'npm ci'
                // Both the panel and the daemon import from the shared package's build
                // output, so nothing typechecks until it exists.
                sh 'npm run build:shared'
            }
        }

        stage('Verify') {
            when { expression { !params.SKIP_TESTS } }
            steps {
                sh 'npm run typecheck'
                sh 'npm test'
            }
        }

        stage('Publish images') {
            steps {
                script {
                    // Docker Hub first: every Dockerfile here starts FROM an image on it,
                    // and anonymous pulls run out partway through a five-image build.
                    withCredentials([usernamePassword(
                        credentialsId: 'docker-hub-creds',
                        usernameVariable: 'DH_USER',
                        passwordVariable: 'DH_PASS'
                    )]) {
                        sh 'set +x; echo "$DH_PASS" | docker login -u "$DH_USER" --password-stdin'
                    }

                    withCredentials([usernamePassword(
                        credentialsId: 'github-token',
                        usernameVariable: 'GH_USER',
                        passwordVariable: 'GH_TOKEN'
                    )]) {
                        sh 'set +x; echo "$GH_TOKEN" | docker login ghcr.io -u "$GH_USER" --password-stdin'
                    }

                    sh 'docker buildx create --name craftcontrol --use || docker buildx use craftcontrol'

                    [
                        ['web',         'apps/web/Dockerfile'],
                        ['daemon',      'apps/daemon/Dockerfile'],
                        ['proxy',       'apps/proxy/Dockerfile'],
                        ['nanolimbo',   'apps/nanolimbo/Dockerfile'],
                        ['discord-bot', 'apps/discord-bot/Dockerfile'],
                    ].each { name, dockerfile ->
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
