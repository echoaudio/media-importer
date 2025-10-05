import 'dotenv/config'
import SftpClient from 'ssh2-sftp-client'
import axios from 'axios'
import path from 'path'
import { default as PQueue } from 'p-queue'
import { createHash } from 'crypto'
import { parseBuffer, selectCover } from 'music-metadata'
import FormData from 'form-data'
import chalk from 'chalk'
import logUpdate from 'log-update'

// Import user configuration
import { config } from './config.js'

// --- Global Variables ---
const {
  FTP_HOST,
  FTP_PORT,
  FTP_USER,
  FTP_PASSWORD,
  API_BASE_URL,
  API_PROJECT_ID,
  API_TOKEN
} = process.env

// --- API Client ---
const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: { Authorization: `Bearer ${API_TOKEN}` }
})

// --- Global State for UI and Progress Tracking ---
const existingMediaCache = new Map()
const activeTasks = new Map()
const failedTasks = []
let totalFilesToProcess = 0
let completedFiles = 0
let totalSizeToProcess = 0
let totalBytesUploaded = 0
let startTime = 0

// --- Formatting & UI Rendering Helpers ---
const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
}

const generateBar = (percentage, length = 20) => {
  const progress = Math.round((percentage / 100) * length)
  const empty = length - progress
  return `[${'█'.repeat(progress)}${'░'.repeat(empty)}]`
}

const renderUI = () => {
  const elapsedTimeInSeconds = (Date.now() - startTime) / 1000
  const avgSpeed =
    elapsedTimeInSeconds > 0 ? totalBytesUploaded / elapsedTimeInSeconds : 0
  const percentageComplete =
    totalFilesToProcess > 0
      ? Math.floor((completedFiles / totalFilesToProcess) * 100)
      : 0

  let output = `Total Progress ${generateBar(percentageComplete)} ${percentageComplete}% | ${completedFiles}/${totalFilesToProcess} Files\n`
  output += `Data: ${formatBytes(totalBytesUploaded)} / ${formatBytes(totalSizeToProcess)} | Avg Speed: ${formatBytes(avgSpeed)}/s\n\n`
  output += chalk.bold('Active Tasks:\n')

  const visibleTasks = Array.from(activeTasks.values()).slice(
    0,
    config.display.maxVisibleTasks
  )

  if (visibleTasks.length === 0) {
    output += chalk.gray('...waiting for tasks...')
  } else {
    visibleTasks.forEach((task) => {
      const bar = generateBar(task.progress)
      output += `↳ "${chalk.yellow(task.name)}" ${bar} ${task.progress}% | ${task.status}\n`
    })
  }

  const hiddenTasks = activeTasks.size - visibleTasks.length
  if (hiddenTasks > 0) {
    output += chalk.gray(`...and ${hiddenTasks} more.`)
  }

  logUpdate(output)
}

/** Calculates the hash of a file buffer. */
function calculateHash(buffer) {
  return createHash(config.hashingAlgorithm).update(buffer).digest('hex')
}

/** Uploads a new media file to the radio platform. */
async function uploadFile(fileBuffer, metadata, mediaType, fileHash, filename) {
  const form = new FormData()
  form.append('file', fileBuffer, { filename })
  form.append('mediaType', mediaType)
  form.append('hash', fileHash)
  form.append('extended', 'false')

  const common = metadata.common
  if (common.artist) form.append('artist', common.artist)
  if (common.title) form.append('title', common.title)

  const picture = selectCover(metadata.common.picture)
  if (picture) {
    const extension = picture.format.split('/')[1] || 'jpg'
    form.append('cover', picture.data, {
      filename: `cover.${extension}`,
      contentType: picture.format
    })
  }

  try {
    const response = await apiClient.post(
      `/project/${API_PROJECT_ID}/media/upload`,
      form,
      {
        headers: form.getHeaders(),
        onUploadProgress: (progressEvent) => {
          const percentage = Math.floor(
            (progressEvent.loaded * 100) / progressEvent.total
          )
          const task = activeTasks.get(filename)
          if (task) {
            task.progress = percentage
            const lastLoaded = task.lastLoaded || 0
            totalBytesUploaded += progressEvent.loaded - lastLoaded
            task.lastLoaded = progressEvent.loaded
          }
        }
      }
    )
    return response.data
  } catch (error) {
    const task = activeTasks.get(filename)
    if (task) task.status = chalk.red('Error')
    throw error
  }
}

/** Adds an existing media item to a specific playlist. */
async function addToPlaylist(mediaId, playlistId, filename) {
  const task = activeTasks.get(filename)
  if (task) task.status = chalk.magenta('Playlist...')
  try {
    await apiClient.post(
      `/project/${API_PROJECT_ID}/media/playlist/${playlistId}/item`,
      { position: 0, items: [{ id: mediaId }] }
    )
  } catch (error) {
    if (error.response?.status !== 409) throw error
  }
}

/** Processes a single file from the SFTP server. */
async function processFile(fileInfo, folderConfig, sftp) {
  const filePath = path.posix.join(folderConfig.path, fileInfo.name)
  const taskState = {
    name: fileInfo.name,
    status: chalk.gray('Pending...'),
    progress: 0,
    lastLoaded: 0
  }
  activeTasks.set(filePath, taskState)

  try {
    taskState.status = chalk.yellow('Downloading...')
    const fileBuffer = await sftp.get(filePath)

    taskState.status = chalk.yellow('Hashing...')
    const fileHash = calculateHash(fileBuffer)
    let mediaId = existingMediaCache.get(fileHash)

    if (mediaId) {
      taskState.status = chalk.yellow('Duplicate')
      taskState.progress = 100
    } else {
      taskState.status = chalk.yellow('Parsing...')

      const metadata = await parseBuffer(fileBuffer, {
        size: fileInfo.size,
        path: fileInfo.name
      })

      taskState.status = chalk.cyan('Uploading...')
      const newMedia = await uploadFile(
        fileBuffer,
        metadata,
        folderConfig.mediaType,
        fileHash,
        filePath
      )
      mediaId = newMedia.id
      existingMediaCache.set(fileHash, mediaId)
    }

    if (mediaId && folderConfig.playlist) {
      await addToPlaylist(mediaId, folderConfig.playlist, filePath)
    }

    taskState.status = chalk.green('✓ Done')
    taskState.progress = 100
  } catch (error) {
    taskState.status = chalk.red(`Error: ${error.message.substring(0, 30)}`)
    failedTasks.push({ name: fileInfo.name, reason: error.message })
  } finally {
    completedFiles++
    setTimeout(() => activeTasks.delete(filePath), 2000)
  }
}

/** Main function to run the importer. */
async function run() {
  const sftp = new SftpClient()
  const queue = new PQueue({ concurrency: config.performance.concurrency })
  const allFilesToProcess = []
  let uiInterval = null

  try {
    console.log(chalk.bold.green('Connecting...'))
    await sftp.connect({
      host: FTP_HOST,
      port: FTP_PORT,
      username: FTP_USER,
      password: FTP_PASSWORD
    })

    sftp.client.setMaxListeners(config.performance.concurrency + 10)

    for (const folder of config.folders) {
      const fileList = await sftp.list(folder.path)
      for (const file of fileList) {
        if (
          file.type === '-' &&
          config.supportedExtensions.includes(
            path.extname(file.name).toLowerCase()
          )
        ) {
          allFilesToProcess.push({ fileInfo: file, folderConfig: folder })
          totalSizeToProcess += file.size
        }
      }
    }
    totalFilesToProcess = allFilesToProcess.length

    // Start the UI render loop
    startTime = Date.now()
    uiInterval = setInterval(renderUI, 100)

    if (totalFilesToProcess > 0) {
      allFilesToProcess.forEach(({ fileInfo, folderConfig }) => {
        queue.add(() => processFile(fileInfo, folderConfig, sftp))
      })
      await queue.onIdle()
      await new Promise((resolve) => setTimeout(resolve, 2100)) // Wait for "Done" messages to clear
    }
  } catch (err) {
    logUpdate.clear()
    console.error(
      chalk.red(`\n[CRITICAL] A critical error occurred: ${err.message}`)
    )
  } finally {
    if (uiInterval) clearInterval(uiInterval)
    logUpdate.done()

    console.log(chalk.bold('\nSummary'))
    if (failedTasks.length === 0) {
      if (totalFilesToProcess > 0) {
        console.log(
          chalk.green(
            `✔ Success! All ${totalFilesToProcess} files were processed.`
          )
        )
      } else {
        console.log(chalk.yellow('No files found to process.'))
      }
    } else {
      const successCount = totalFilesToProcess - failedTasks.length
      console.log(
        `${chalk.green(`${successCount} successful`)} | ${chalk.red(`${failedTasks.length} failed`)}`
      )
      console.log(chalk.bold.red('\nFailed Files:'))
      failedTasks.forEach((task) => {
        console.log(`  - "${task.name}": ${chalk.red(task.reason)}`)
      })
    }

    if (sftp.client && sftp.client.sftp) await sftp.end()
  }
}

run()
