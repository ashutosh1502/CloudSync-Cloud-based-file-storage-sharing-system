// Firebase configuration
const firebaseConfig = {
    apiKey: "your-key",
    authDomain: "domain",
    projectId: "id",
    storageBucket: "s3-bucket",
    messagingSenderId: "sender-id",
    appId: "api-id"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();

async function processPendingInvitations(user) {
    try {
        const pendingInvitationsKey = `pending_invitations/${user.email}.json`;
        let invitations = [];

        try {
            const response = await s3.getObject({
                Bucket: bucketName,
                Key: pendingInvitationsKey
            }).promise();
            invitations = JSON.parse(response.Body.toString());
        } catch (error) {
            if (error.code !== 'NoSuchKey') throw error;
            return; // No pending invitations
        }

        let rooms = [];
        try {
            const response = await s3.getObject({
                Bucket: bucketName,
                Key: 'rooms/index.json'
            }).promise();
            rooms = JSON.parse(response.Body.toString());
        } catch (error) {
            if (error.code !== 'NoSuchKey') throw error;
        }

        for (const invitation of invitations) {
            try {
                const room = await getRoomData(invitation.roomId);
                if (!room) continue;

                const memberIndex = room.members.findIndex(m =>
                    m.email === user.email && (m.status === 'pending' || m.id.startsWith('pending_'))
                );

                if (memberIndex !== -1) {
                    room.members[memberIndex] = {
                        id: user.uid,
                        email: user.email,
                        displayName: user.displayName || user.email.split('@')[0],
                        role: invitation.role,
                        invitedAt: invitation.invitedAt,
                        invitedBy: invitation.invitedBy
                    };

                    await updateRoomData(invitation.roomId, room);

                    const roomIndex = rooms.findIndex(r => r.id === invitation.roomId);
                    if (roomIndex !== -1) {
                        rooms[roomIndex] = room;
                    }

                    await logRoomActivity(invitation.roomId, {
                        type: 'MEMBER_JOINED',
                        memberEmail: user.email,
                        memberId: user.uid,
                        role: invitation.role,
                        timestamp: new Date().toISOString()
                    });

                    await createUserNotification(user.uid, {
                        type: 'ROOM_JOINED',
                        roomId: invitation.roomId,
                        roomName: invitation.roomName,
                        timestamp: new Date().toISOString()
                    });
                }
            } catch (error) {
                console.error('Error processing invitation:', error);
            }
        }

        await s3.putObject({
            Bucket: bucketName,
            Key: 'rooms/index.json',
            Body: JSON.stringify(rooms),
            ContentType: 'application/json'
        }).promise();

        await s3.deleteObject({
            Bucket: bucketName,
            Key: pendingInvitationsKey
        }).promise();

    } catch (error) {
        console.error('Error processing pending invitations:', error);
    }
}

auth.onAuthStateChanged(async (user) => {
    if (user) {
        console.log('User is signed in:', user);

        await updateUserIndex({
            id: user.uid,
            email: user.email,
            displayName: user.displayName,
            lastLogin: new Date().toISOString()
        });

        await processPendingInvitations(user);

        updateProfileUI(user);
        loadFolders();
        loadExistingFiles();
        loadRooms();

        const searchBar = document.querySelector('.search-bar');
        searchBar.addEventListener('input', (e) => {
            filterFiles(e.target.value);
        });
    } else {
        window.location.href = 'index.html';
    }
});

function updateProfileUI(user) {
    const username = document.getElementById('username');
    const profilePic = document.getElementById('profilePic');

    username.textContent = user.displayName || user.email;

    if (user.photoURL) {
        profilePic.innerHTML = `<img src="${user.photoURL}" alt="Profile" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">`;
    } else {
        const firstLetter = (user.displayName || user.email)[0].toUpperCase();
        profilePic.textContent = firstLetter;
    }
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
    try {
        await auth.signOut();
        window.location.href = 'index.html';
    } catch (error) {
        console.error('Error signing out:', error);
        alert('Error signing out: ' + error.message);
    }
});

const s3 = new AWS.S3({
    region: "us-east-1",
    credentials: {
        accessKeyId: "your-access-key-id",
        secretAccessKey: "your-secret-access-key",
    },
    signatureVersion: 'v4'
});

const bucketName = "cloud-sync-web-app";

let allFiles = [];

let userFolders = [];

let currentFolder = '';

let userRooms = [];

const ROOM_ROLES = {
    OWNER: 'owner',
    ADMIN: 'admin',
    MEMBER: 'member',
    VIEWER: 'viewer'
};

const ROLE_PERMISSIONS = {
    [ROOM_ROLES.OWNER]: {
        canDelete: true,
        canEdit: true,
        canInvite: true,
        canRemoveMembers: true,
        canUpload: true,
        canDownload: true,
        canDeleteFiles: true,
        canManageRoles: true
    },
    [ROOM_ROLES.ADMIN]: {
        canDelete: false,
        canEdit: true,
        canInvite: true,
        canRemoveMembers: true,
        canUpload: true,
        canDownload: true,
        canDeleteFiles: true,
        canManageRoles: false
    },
    [ROOM_ROLES.MEMBER]: {
        canDelete: false,
        canEdit: false,
        canInvite: false,
        canRemoveMembers: false,
        canUpload: true,
        canDownload: true,
        canDeleteFiles: false,
        canManageRoles: false
    },
    [ROOM_ROLES.VIEWER]: {
        canDelete: false,
        canEdit: false,
        canInvite: false,
        canRemoveMembers: false,
        canUpload: false,
        canDownload: true,
        canDeleteFiles: false,
        canManageRoles: false
    }
};

function getFileNameFromPath(fullPath) {
    return fullPath.split('/').pop();
}

function createFileItemElement(fileKey, fileUrl) {
    const fileName = getFileNameFromPath(fileKey);

    const fileItem = document.createElement('div');
    fileItem.className = 'file-item';

    const fileIcon = document.createElement('div');
    fileIcon.className = 'file-icon';

    const extension = fileName.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp'].includes(extension)) {
        fileIcon.textContent = '🖼️';
    } else if (['mp4', 'avi', 'mov', 'wmv'].includes(extension)) {
        fileIcon.textContent = '🎥';
    } else if (['mp3', 'wav', 'ogg'].includes(extension)) {
        fileIcon.textContent = '🎵';
    } else if (extension === 'pdf') {
        fileIcon.textContent = '📄';
    } else {
        fileIcon.textContent = '📝';
    }

    const fileName_el = document.createElement('div');
    fileName_el.className = 'file-name';
    fileName_el.textContent = fileName; // Display only the filename, not the full path

    const fileActions = document.createElement('div');
    fileActions.className = 'file-actions';
    fileActions.style.position = 'relative';

    const moreOptionsBtn = document.createElement('button');
    moreOptionsBtn.className = 'more-options-btn';
    moreOptionsBtn.innerHTML = '⋮';
    moreOptionsBtn.title = 'More options';

    const dropdownMenu = document.createElement('div');
    dropdownMenu.className = 'dropdown-menu';

    const dropdownItems = [
        { icon: '✏️', text: 'Rename', action: () => handleRename(fileKey, fileName_el) },
        { icon: '⬇️', text: 'Download', action: () => handleDownload(fileUrl, fileKey) },
        { icon: '🗑️', text: 'Delete', action: () => handleDelete(fileKey, fileItem) }
    ];

    dropdownItems.forEach(item => {
        const dropdownItem = document.createElement('div');
        dropdownItem.className = 'dropdown-item';
        dropdownItem.innerHTML = `${item.icon} ${item.text}`;
        dropdownItem.addEventListener('click', (e) => {
            e.stopPropagation();
            item.action();
            dropdownMenu.classList.remove('active');
        });
        dropdownMenu.appendChild(dropdownItem);
    });

    moreOptionsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdownMenu.classList.toggle('active');
        document.querySelectorAll('.dropdown-menu.active').forEach(menu => {
            if (menu !== dropdownMenu) {
                menu.classList.remove('active');
            }
        });
    });

    document.addEventListener('click', () => {
        dropdownMenu.classList.remove('active');
    });

    const copyLinkBtn = document.createElement('button');
    copyLinkBtn.className = 'copy-link-btn';
    copyLinkBtn.innerHTML = '<span>🔗</span>Copy link';

    copyLinkBtn.addEventListener('click', async () => {
        try {
            const presignedUrl = await generatePresignedDownloadUrl(fileKey, 7 * 24 * 60 * 60);

            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(presignedUrl);
            } else {
                // Fallback for unsupported browsers
                const tempInput = document.createElement('input');
                tempInput.value = presignedUrl;
                document.body.appendChild(tempInput);
                tempInput.select();
                document.execCommand('copy');
                document.body.removeChild(tempInput);
            }

            const successMsg = document.createElement('div');
            successMsg.textContent = 'Link copied! (Valid for 7 days)';
            successMsg.style.position = 'fixed';
            successMsg.style.bottom = '20px';
            successMsg.style.right = '20px';
            successMsg.style.background = '#4CAF50';
            successMsg.style.color = 'white';
            successMsg.style.padding = '10px 20px';
            successMsg.style.borderRadius = '5px';
            successMsg.style.zIndex = '1000';
            document.body.appendChild(successMsg);

            setTimeout(() => {
                document.body.removeChild(successMsg);
            }, 2000);
        } catch (error) {
            console.error('Error copying link:', error);
            alert('Failed to copy link: ' + error.message);
        }
    });


    fileActions.appendChild(moreOptionsBtn);
    fileActions.appendChild(dropdownMenu);
    fileActions.appendChild(copyLinkBtn);

    fileItem.appendChild(fileIcon);
    fileItem.appendChild(fileName_el);
    fileItem.appendChild(fileActions);

    return fileItem;
}

async function handleRename(oldFileKey, fileNameElement) {
    const oldFileName = getFileNameFromPath(oldFileKey);
    const newFileName = prompt('Enter new file name:', oldFileName);

    if (newFileName && newFileName !== oldFileName) {
        try {
            const userId = firebase.auth().currentUser.uid;
            const newFileKey = `users/${userId}/${newFileName}`;

            const params = {
                Bucket: bucketName,
                CopySource: `${bucketName}/${oldFileKey}`,
                Key: newFileKey
            };

            await s3.copyObject(params).promise();

            await s3.deleteObject({
                Bucket: bucketName,
                Key: oldFileKey
            }).promise();

            fileNameElement.textContent = newFileName;
        } catch (error) {
            console.error('Error renaming file:', error);
            alert('Failed to rename file: ' + error.message);
        }
    }
}

async function generatePresignedDownloadUrl(fileKey, expirationSeconds = 3600) {
    return new Promise((resolve, reject) => {
        const params = {
            Bucket: bucketName,
            Key: fileKey,
            Expires: expirationSeconds,
            ResponseContentDisposition: `attachment; filename="${getFileNameFromPath(fileKey)}"` // Use only filename for download
        };

        s3.getSignedUrl('getObject', params, (err, url) => {
            if (err) {
                console.error('Error generating download URL:', err);
                reject(err);
            } else {
                resolve(url);
            }
        });
    });
}

function createDownloadOverlay(fileName) {
    const overlay = document.createElement('div');
    overlay.className = 'download-overlay';

    const content = document.createElement('div');
    content.className = 'download-content';

    const icon = document.createElement('div');
    icon.className = 'download-icon';
    icon.textContent = getFileIcon(fileName);

    const title = document.createElement('h3');
    title.textContent = 'Downloading File';

    const fileInfo = document.createElement('div');
    fileInfo.className = 'download-info';
    fileInfo.textContent = fileName;

    const progress = document.createElement('div');
    progress.className = 'download-progress';
    const progressBar = document.createElement('div');
    progressBar.className = 'download-bar';
    progress.appendChild(progressBar);

    const status = document.createElement('div');
    status.className = 'download-status';
    status.textContent = 'Preparing download...';

    content.appendChild(icon);
    content.appendChild(title);
    content.appendChild(fileInfo);
    content.appendChild(progress);
    content.appendChild(status);
    overlay.appendChild(content);

    document.body.appendChild(overlay);

    // Show overlay with animation
    setTimeout(() => overlay.classList.add('active'), 0);

    return {
        overlay,
        progressBar,
        status,
        icon,
        updateProgress: (percent) => {
            progressBar.style.width = `${percent}%`;
        },
        setSuccess: () => {
            icon.textContent = '✅';
            icon.classList.add('success-animation');
            status.textContent = 'Download Complete!';
            progressBar.style.width = '100%';
        },
        setError: (error) => {
            icon.textContent = '❌';
            icon.classList.add('success-animation');
            status.textContent = `Download failed: ${error}`;
            status.style.color = '#f44336';
        },
        hide: () => {
            overlay.classList.remove('active');
            setTimeout(() => overlay.remove(), 300);
        }
    };
}

// Function to handle download
async function handleDownload(fileUrl, fileName) {
    const downloadUI = createDownloadOverlay(fileName);

    try {
        // Generate a presigned URL for download
        downloadUI.status.textContent = 'Generating secure download link...';
        const presignedUrl = await generatePresignedDownloadUrl(fileName);

        downloadUI.status.textContent = 'Starting download...';

        // Fetch the file
        const response = await fetch(presignedUrl);
        if (!response.ok) throw new Error('Download failed');

        const reader = response.body.getReader();
        const contentLength = +response.headers.get('Content-Length');

        let receivedLength = 0;
        const chunks = [];

        // Read the response stream
        while (true) {
            const { done, value } = await reader.read();

            if (done) break;

            chunks.push(value);
            receivedLength += value.length;

            // Update progress
            const progress = (receivedLength / contentLength) * 100;
            downloadUI.updateProgress(progress);
            downloadUI.status.textContent = `Downloading: ${formatFileSize(receivedLength)} of ${formatFileSize(contentLength)}`;
        }

        // Combine all chunks into a single Blob
        const blob = new Blob(chunks);
        const url = window.URL.createObjectURL(blob);

        // Create download link
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);

        // Trigger download
        link.click();

        // Cleanup
        window.URL.revokeObjectURL(url);
        document.body.removeChild(link);

        // Show success and hide overlay
        downloadUI.setSuccess();
        setTimeout(() => downloadUI.hide(), 2000);

    } catch (error) {
        console.error('Error downloading file:', error);
        downloadUI.setError(error.message);
        setTimeout(() => downloadUI.hide(), 3000);
    }
}

// Function to handle delete
async function handleDelete(fileKey, fileElement) {
    const fileName = getFileNameFromPath(fileKey);
    if (confirm(`Are you sure you want to delete ${fileName}?`)) {
        try {
            await s3.deleteObject({
                Bucket: bucketName,
                Key: fileKey
            }).promise();

            // Remove the file element from the UI
            fileElement.remove();
        } catch (error) {
            console.error('Error deleting file:', error);
            alert('Failed to delete file: ' + error.message);
        }
    }
}

// Function to fetch all files from S3 bucket
async function fetchExistingFiles() {
    // Get current user's ID
    const userId = firebase.auth().currentUser.uid;

    return new Promise((resolve, reject) => {
        const params = {
            Bucket: bucketName,
            Prefix: `users/${userId}/`,
            Delimiter: '/' // Use delimiter to get only root-level items
        };

        console.log('Fetching files from bucket:', bucketName);
        s3.listObjects(params, (err, data) => {
            if (err) {
                console.error('Error fetching files:', err);
                reject(err);
            } else {
                // Filter out folders (CommonPrefixes) and get only files
                const files = data.Contents.filter(item => {
                    // Exclude the root directory itself and any items that are in subfolders
                    const key = item.Key;
                    const relativePath = key.replace(`users/${userId}/`, '');
                    // Exclude system/metadata files (all .json files)
                    if (relativePath.endsWith('.json')) return false;
                    return key !== `users/${userId}/` && !relativePath.includes('/');
                });

                console.log('Successfully fetched files:', files);
                resolve(files);
            }
        });
    });
}

// Function to filter files based on search query
function filterFiles(searchQuery) {
    const recentFiles = document.querySelector('.recent-files');
    const query = searchQuery.toLowerCase();

    // Clear existing files (except the heading)
    while (recentFiles.children.length > 1) {
        recentFiles.removeChild(recentFiles.lastChild);
    }

    // Filter and display matching files
    const matchingFiles = allFiles.filter(file => {
        const fileName = getFileNameFromPath(file.Key);
        return fileName.toLowerCase().includes(query);
    });

    // Sort files by last modified date, most recent first
    matchingFiles.sort((a, b) => b.LastModified - a.LastModified);

    // Display matching files
    matchingFiles.forEach(file => {
        const fileUrl = `https://${bucketName}.s3.amazonaws.com/${file.Key}`;
        const fileItem = createFileItemElement(file.Key, fileUrl);
        recentFiles.appendChild(fileItem);
    });

    // Show no results message if needed
    if (matchingFiles.length === 0 && searchQuery !== '') {
        const noResults = document.createElement('div');
        noResults.style.padding = '20px';
        noResults.style.textAlign = 'center';
        noResults.style.color = '#666';
        noResults.textContent = 'No matching files found';
        recentFiles.appendChild(noResults);
    }
}

// Function to create loading animation
function createLoadingAnimation(text) {
    const loadingContainer = document.createElement('div');
    loadingContainer.className = 'loading-container';

    const spinnerContainer = document.createElement('div');
    spinnerContainer.className = 'loading-spinner-container';

    const spinner = document.createElement('div');
    spinner.className = 'loading-spinner';

    const loadingText = document.createElement('div');
    loadingText.className = 'loading-text';
    loadingText.textContent = text;

    spinnerContainer.appendChild(spinner);
    loadingContainer.appendChild(spinnerContainer);
    loadingContainer.appendChild(loadingText);

    return loadingContainer;
}

// Function to create skeleton loading animation
function createSkeletonLoading(count = 3) {
    const container = document.createElement('div');
    for (let i = 0; i < count; i++) {
        const skeleton = document.createElement('div');
        skeleton.className = 'skeleton-item';
        container.appendChild(skeleton);
    }
    return container;
}

// Function to load folders
async function loadFolders() {
    const foldersGrid = document.querySelector('.folders-grid');
    foldersGrid.innerHTML = ''; // Clear existing folders

    // Add loading animation
    const loadingAnimation = createLoadingAnimation('Loading folders...');
    foldersGrid.appendChild(loadingAnimation);

    try {
        const userId = firebase.auth().currentUser.uid;
        const prefix = `users/${userId}/`;

        const objects = await s3.listObjects({
            Bucket: bucketName,
            Prefix: prefix,
            Delimiter: '/'
        }).promise();

        // Remove loading animation
        foldersGrid.innerHTML = '';

        // Get folder names from CommonPrefixes
        userFolders = objects.CommonPrefixes ? objects.CommonPrefixes.map(prefix => {
            const folderName = prefix.Prefix.split('/').slice(-2)[0];
            return folderName;
        }) : [];

        // Add folder elements to UI
        if (userFolders.length === 0) {
            const noFolders = document.createElement('div');
            noFolders.style.padding = '20px';
            noFolders.style.textAlign = 'center';
            noFolders.style.color = '#666';
            noFolders.textContent = 'No folders created yet. Create a folder to organize your files!';
            foldersGrid.appendChild(noFolders);
        } else {
            userFolders.forEach(folderName => {
                const folderItem = createFolderItemElement(folderName);
                foldersGrid.appendChild(folderItem);
            });
        }
    } catch (error) {
        console.error('Error loading folders:', error);
        foldersGrid.innerHTML = '';
        const errorMessage = document.createElement('div');
        errorMessage.style.padding = '20px';
        errorMessage.style.color = 'red';
        errorMessage.textContent = 'Error loading folders. Please try again.';
        foldersGrid.appendChild(errorMessage);
    }
}

// Function to load existing files into the recent files section
async function loadExistingFiles() {
    const recentFiles = document.querySelector('.recent-files');

    // Clear any existing content except the heading
    while (recentFiles.children.length > 1) {
        recentFiles.removeChild(recentFiles.lastChild);
    }

    // Add loading animation
    const loadingAnimation = createSkeletonLoading(4);
    recentFiles.appendChild(loadingAnimation);

    try {
        console.log('Starting to load existing files...');

        // Make sure user is authenticated
        const user = firebase.auth().currentUser;
        if (!user) {
            throw new Error('User not authenticated');
        }

        allFiles = await fetchExistingFiles(); // Store files globally
        console.log('Retrieved files:', allFiles);

        // Remove loading animation
        while (recentFiles.children.length > 1) {
            recentFiles.removeChild(recentFiles.lastChild);
        }

        // Sort files by last modified date, most recent first
        allFiles.sort((a, b) => b.LastModified - a.LastModified);

        // Add each file to the recent files section
        if (allFiles.length === 0) {
            // Show message when no files exist
            const noFiles = document.createElement('div');
            noFiles.style.padding = '20px';
            noFiles.style.textAlign = 'center';
            noFiles.style.color = '#666';
            noFiles.textContent = 'No files in root directory. Use folders to organize your files!';
            recentFiles.appendChild(noFiles);
        } else {
            for (const file of allFiles) {
                const fileUrl = `https://${bucketName}.s3.amazonaws.com/${file.Key}`;
                const fileItem = createFileItemElement(file.Key, fileUrl);
                recentFiles.appendChild(fileItem);
            }
        }
        console.log('Finished loading files into UI');
    } catch (error) {
        console.error('Error loading existing files:', error);
        // Remove loading animation and show error
        while (recentFiles.children.length > 1) {
            recentFiles.removeChild(recentFiles.lastChild);
        }
        const errorMessage = document.createElement('div');
        errorMessage.style.padding = '20px';
        errorMessage.style.color = 'red';
        errorMessage.textContent = 'Error loading files. Please check console for details.';
        recentFiles.appendChild(errorMessage);
    }
}

// Function to upload file directly using AWS SDK
async function uploadFileToS3(file) {
    const userId = firebase.auth().currentUser.uid;

    // Determine the file path based on context
    let filePath;
    if (currentFolder.startsWith('rooms/')) {
        // If we're in a room, use the room's files directory
        filePath = `${currentFolder}/files/${file.name}`;
    } else {
        // Otherwise, use the user's personal directory
        filePath = currentFolder
            ? `users/${userId}/${currentFolder}/${file.name}`
            : `users/${userId}/${file.name}`;
    }

    return new Promise((resolve, reject) => {
        const params = {
            Bucket: bucketName,
            Key: filePath,
            Body: file,
            ContentType: file.type
        };

        s3.upload(params, (err, data) => {
            if (err) {
                console.error('Error:', err);
                reject(err);
            } else {
                resolve(data.Location);
            }
        });
    });
}

// Create a hidden file input element
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.multiple = true; // Allow multiple file selection
fileInput.style.display = 'none';
document.body.appendChild(fileInput);

// Get the upload button
const uploadButton = document.querySelector('.upload-btn');

// Add click event listener to the upload button
uploadButton.addEventListener('click', () => {
    fileInput.click(); // Trigger the file input click
});

// Create upload overlay
function createUploadOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'upload-overlay';

    const content = document.createElement('div');
    content.className = 'upload-content';

    const title = document.createElement('h3');
    title.textContent = 'Uploading Files';

    const spinner = document.createElement('div');
    spinner.className = 'loading-spinner';

    const progress = document.createElement('div');
    progress.className = 'upload-progress';
    const progressBar = document.createElement('div');
    progressBar.className = 'progress-bar';
    progress.appendChild(progressBar);

    const status = document.createElement('div');
    status.className = 'upload-status';

    const filesList = document.createElement('div');
    filesList.className = 'upload-files';

    content.appendChild(title);
    content.appendChild(spinner);
    content.appendChild(progress);
    content.appendChild(status);
    content.appendChild(filesList);
    overlay.appendChild(content);

    document.body.appendChild(overlay);

    return {
        overlay,
        progressBar,
        status,
        filesList,
        show: () => {
            overlay.classList.add('active');
        },
        hide: () => {
            overlay.classList.remove('active');
            setTimeout(() => {
                overlay.remove();
            }, 300);
        },
        updateProgress: (current, total) => {
            const percentage = (current / total) * 100;
            progressBar.style.width = `${percentage}%`;
            status.textContent = `Uploading ${current} of ${total} files`;
        },
        addFile: (fileName, size) => {
            const fileItem = document.createElement('div');
            fileItem.className = 'upload-file-item';

            const icon = document.createElement('div');
            icon.className = 'file-icon';
            icon.textContent = getFileIcon(fileName);

            const details = document.createElement('div');
            details.className = 'file-details';

            const name = document.createElement('div');
            name.className = 'file-name';
            name.textContent = fileName;

            const fileSize = document.createElement('div');
            fileSize.className = 'file-size';
            fileSize.textContent = formatFileSize(size);

            details.appendChild(name);
            details.appendChild(fileSize);

            const status = document.createElement('div');
            status.className = 'file-status';

            fileItem.appendChild(icon);
            fileItem.appendChild(details);
            fileItem.appendChild(status);
            filesList.appendChild(fileItem);

            return {
                setSuccess: () => {
                    status.innerHTML = '✅';
                    status.className = 'file-status success-icon';
                },
                setError: () => {
                    status.innerHTML = '❌';
                    status.className = 'file-status error-icon';
                }
            };
        }
    };
}

// Helper function to get file icon
function getFileIcon(fileName) {
    const extension = fileName.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp'].includes(extension)) {
        return '🖼️';
    } else if (['mp4', 'avi', 'mov', 'wmv'].includes(extension)) {
        return '🎥';
    } else if (['mp3', 'wav', 'ogg'].includes(extension)) {
        return '🎵';
    } else if (extension === 'pdf') {
        return '📄';
    }
    return '📝';
}

// Helper function to format file size
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Handle file selection
fileInput.addEventListener('change', async (event) => {
    const files = event.target.files;

    if (files.length > 0) {
        const recentFiles = document.querySelector('.recent-files');

        // Create and show upload overlay
        const uploadUI = createUploadOverlay();
        uploadUI.show();

        let successCount = 0;
        const fileStatuses = [];

        // Add files to the upload list
        Array.from(files).forEach(file => {
            fileStatuses.push(uploadUI.addFile(file.name, file.size));
        });

        // Process each selected file
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            uploadUI.updateProgress(i + 1, files.length);

            try {
                // Upload the file directly using AWS SDK
                const fileUrl = await uploadFileToS3(file);
                const fileKey = currentFolder
                    ? `users/${firebase.auth().currentUser.uid}/${currentFolder}/${file.name}`
                    : `users/${firebase.auth().currentUser.uid}/${file.name}`;
                const fileItem = createFileItemElement(fileKey, fileUrl);

                // Add the new file item to the beginning of the recent files section
                const heading = recentFiles.querySelector('h2');
                recentFiles.insertBefore(fileItem, heading.nextSibling);

                // Update file status in overlay
                fileStatuses[i].setSuccess();
                successCount++;

            } catch (error) {
                console.error(`Error processing ${file.name}:`, error);
                fileStatuses[i].setError();
            }
        }

        // Update final status
        uploadUI.status.textContent = `Uploaded ${successCount} of ${files.length} files`;

        // Hide overlay after a delay
        setTimeout(() => {
            uploadUI.hide();
            // Refresh the current view
            if (currentFolder) {
                openFolder(currentFolder);
            } else {
                loadExistingFiles();
            }
        }, 2000);

        // Clear the file input for future uploads
        fileInput.value = '';
    }
});

// Initialize when the page loads
document.addEventListener('DOMContentLoaded', () => {
    // Remove the loadExistingFiles call from here since it will be called after authentication
    // Just ensure the search bar is ready
    const searchBar = document.querySelector('.search-bar');
    if (searchBar) {
        searchBar.value = ''; // Clear any existing search
    }
});

// Function to create folder in S3
async function createFolder(folderName) {
    const userId = firebase.auth().currentUser.uid;
    const folderKey = `users/${userId}/${folderName}/`; // Note the trailing slash

    try {
        // Create an empty object to represent the folder
        await s3.putObject({
            Bucket: bucketName,
            Key: folderKey,
            Body: '' // Empty content
        }).promise();

        // Add the folder to UI
        await loadFolders();
        return true;
    } catch (error) {
        console.error('Error creating folder:', error);
        throw error;
    }
}

// Function to create folder item element
function createFolderItemElement(folderName) {
    const folderItem = document.createElement('div');
    folderItem.className = 'folder-item';

    const folderIcon = document.createElement('div');
    folderIcon.className = 'folder-icon';
    folderIcon.textContent = '📁';

    const folderNameEl = document.createElement('div');
    folderNameEl.className = 'folder-name';
    folderNameEl.textContent = folderName;

    const folderActions = document.createElement('div');
    folderActions.className = 'folder-actions';

    // Create rename and delete buttons
    const renameBtn = document.createElement('button');
    renameBtn.innerHTML = '✏️';
    renameBtn.title = 'Rename folder';
    renameBtn.onclick = (e) => {
        e.stopPropagation();
        handleFolderRename(folderName);
    };

    const deleteBtn = document.createElement('button');
    deleteBtn.innerHTML = '🗑️';
    deleteBtn.title = 'Delete folder';
    deleteBtn.onclick = (e) => {
        e.stopPropagation();
        handleFolderDelete(folderName);
    };

    folderActions.appendChild(renameBtn);
    folderActions.appendChild(deleteBtn);

    folderItem.appendChild(folderIcon);
    folderItem.appendChild(folderNameEl);
    folderItem.appendChild(folderActions);

    // Add click handler to open folder
    folderItem.addEventListener('click', () => {
        openFolder(folderName);
    });

    return folderItem;
}

// Function to handle folder rename
async function handleFolderRename(oldFolderName) {
    const newFolderName = prompt('Enter new folder name:', oldFolderName);
    if (newFolderName && newFolderName !== oldFolderName) {
        try {
            const userId = firebase.auth().currentUser.uid;
            const oldPrefix = `users/${userId}/${oldFolderName}/`;
            const newPrefix = `users/${userId}/${newFolderName}/`;

            // List all objects in the folder
            const objects = await s3.listObjects({
                Bucket: bucketName,
                Prefix: oldPrefix
            }).promise();

            // Move each object to the new location
            for (const object of objects.Contents) {
                const newKey = object.Key.replace(oldPrefix, newPrefix);
                await s3.copyObject({
                    Bucket: bucketName,
                    CopySource: `${bucketName}/${object.Key}`,
                    Key: newKey
                }).promise();

                await s3.deleteObject({
                    Bucket: bucketName,
                    Key: object.Key
                }).promise();
            }

            // Refresh folders list
            await loadFolders();
        } catch (error) {
            console.error('Error renaming folder:', error);
            alert('Failed to rename folder: ' + error.message);
        }
    }
}

// Function to handle folder deletion
async function handleFolderDelete(folderName) {
    if (confirm(`Are you sure you want to delete the folder "${folderName}" and all its contents?`)) {
        try {
            const userId = firebase.auth().currentUser.uid;
            const prefix = `users/${userId}/${folderName}/`;

            // List all objects in the folder
            const objects = await s3.listObjects({
                Bucket: bucketName,
                Prefix: prefix
            }).promise();

            // Delete each object
            for (const object of objects.Contents) {
                await s3.deleteObject({
                    Bucket: bucketName,
                    Key: object.Key
                }).promise();
            }

            // Refresh folders list
            await loadFolders();
        } catch (error) {
            console.error('Error deleting folder:', error);
            alert('Failed to delete folder: ' + error.message);
        }
    }
}

// Function to open folder and show its contents
async function openFolder(folderName) {
    const recentFiles = document.querySelector('.recent-files');
    const heading = recentFiles.querySelector('h2');
    heading.textContent = `Folder: ${folderName}`;

    // Set current folder
    currentFolder = folderName;

    // Clear existing files
    while (recentFiles.children.length > 1) {
        recentFiles.removeChild(recentFiles.lastChild);
    }

    // Add loading animation
    const loadingAnimation = createSkeletonLoading(4);
    recentFiles.appendChild(loadingAnimation);

    try {
        const userId = firebase.auth().currentUser.uid;
        const prefix = `users/${userId}/${folderName}/`;

        const objects = await s3.listObjects({
            Bucket: bucketName,
            Prefix: prefix
        }).promise();

        // Remove loading animation
        while (recentFiles.children.length > 1) {
            recentFiles.removeChild(recentFiles.lastChild);
        }

        // Add back button
        const backBtn = document.createElement('button');
        backBtn.className = 'back-btn';
        backBtn.innerHTML = '← Back to all files';
        backBtn.onclick = () => {
            heading.textContent = 'Recent Files';
            currentFolder = ''; // Reset current folder
            loadExistingFiles();
            backBtn.remove();
        };
        recentFiles.insertBefore(backBtn, heading.nextSibling);

        // Show files in the folder
        const files = objects.Contents.filter(obj => !obj.Key.endsWith('/'));
        if (files.length === 0) {
            const noFiles = document.createElement('div');
            noFiles.style.padding = '20px';
            noFiles.style.textAlign = 'center';
            noFiles.style.color = '#666';
            noFiles.textContent = 'This folder is empty. Upload some files!';
            recentFiles.appendChild(noFiles);
        } else {
            files.forEach(file => {
                const fileUrl = `https://${bucketName}.s3.amazonaws.com/${file.Key}`;
                const fileItem = createFileItemElement(file.Key, fileUrl);
                recentFiles.appendChild(fileItem);
            });
        }
    } catch (error) {
        console.error('Error opening folder:', error);
        // Remove loading animation and show error
        while (recentFiles.children.length > 1) {
            recentFiles.removeChild(recentFiles.lastChild);
        }
        const errorMessage = document.createElement('div');
        errorMessage.style.padding = '20px';
        errorMessage.style.color = 'red';
        errorMessage.textContent = 'Failed to open folder. Please try again.';
        recentFiles.appendChild(errorMessage);
    }
}

// Add click handler for create folder button
document.querySelector('.create-folder-btn').addEventListener('click', async () => {
    const folderName = prompt('Enter folder name:');
    if (folderName) {
        try {
            await createFolder(folderName);
        } catch (error) {
            alert('Failed to create folder: ' + error.message);
        }
    }
});

// Add styles for the back button
const style = document.createElement('style');
style.textContent = `
    .back-btn {
        margin-bottom: 1rem;
        padding: 0.5rem 1rem;
        background-color: #f1f3f4;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.9rem;
        color: #1a73e8;
    }
    .back-btn:hover {
        background-color: #e8f0fe;
    }
`;
document.head.appendChild(style);

// Function to highlight search terms in text
function highlightText(text, searchTerm) {
    if (!searchTerm) return text;
    const regex = new RegExp(`(${searchTerm})`, 'gi');
    return text.replace(regex, '<span class="highlight">$1</span>');
}

// Function to perform search
async function performSearch(searchQuery) {
    const searchResults = document.querySelector('.search-results');
    const mainContent = document.querySelector('.main-content');
    const searchContent = searchResults.querySelector('.search-content');

    // Show loading state
    searchContent.innerHTML = '';
    const loadingAnimation = createLoadingAnimation('Searching...');
    searchContent.appendChild(loadingAnimation);

    // Show search results section and hide main content
    searchResults.classList.add('active');
    mainContent.style.display = 'none';

    try {
        const query = searchQuery.toLowerCase();
        const userId = firebase.auth().currentUser.uid;
        const prefix = `users/${userId}/`;

        // Get all objects from S3
        const objects = await s3.listObjects({
            Bucket: bucketName,
            Prefix: prefix
        }).promise();

        // Remove loading animation
        searchContent.innerHTML = '';

        if (!objects.Contents || objects.Contents.length === 0) {
            searchContent.innerHTML = '<div class="no-results">No items found</div>';
            return;
        }

        // Separate folders and files
        const items = objects.Contents.reduce((acc, item) => {
            const relativePath = item.Key.replace(prefix, '');
            const parts = relativePath.split('/');

            if (relativePath.endsWith('/')) {
                // It's a folder
                const folderName = parts[0];
                if (folderName.toLowerCase().includes(query)) {
                    acc.folders.push(folderName);
                }
            } else if (parts.length === 1) {
                // It's a root file
                if (parts[0].toLowerCase().includes(query)) {
                    acc.rootFiles.push(item);
                }
            } else {
                // It's a file in a folder
                const fileName = parts[parts.length - 1];
                const folderName = parts[0];
                if (fileName.toLowerCase().includes(query)) {
                    acc.folderFiles.push({
                        file: item,
                        folderName: folderName
                    });
                }
            }
            return acc;
        }, { folders: [], rootFiles: [], folderFiles: [] });

        // Create results sections
        if (items.folders.length === 0 && items.rootFiles.length === 0 && items.folderFiles.length === 0) {
            searchContent.innerHTML = '<div class="no-results">No matching items found</div>';
            return;
        }

        // Show folders
        if (items.folders.length > 0) {
            const foldersSection = document.createElement('div');
            foldersSection.className = 'search-category';
            foldersSection.innerHTML = `
                <h3>Folders (${items.folders.length})</h3>
                <div class="folders-grid">
                    ${items.folders.map(folderName => `
                        <div class="folder-item" onclick="openFolder('${folderName}')">
                            <div class="folder-icon">📁</div>
                            <div class="folder-name">${highlightText(folderName, searchQuery)}</div>
                        </div>
                    `).join('')}
                </div>
            `;
            searchContent.appendChild(foldersSection);
        }

        // Show root files
        if (items.rootFiles.length > 0) {
            const filesSection = document.createElement('div');
            filesSection.className = 'search-category';
            filesSection.innerHTML = `<h3>Files (${items.rootFiles.length})</h3>`;
            items.rootFiles.forEach(file => {
                const fileUrl = `https://${bucketName}.s3.amazonaws.com/${file.Key}`;
                const fileName = getFileNameFromPath(file.Key);
                const fileItem = createFileItemElement(file.Key, fileUrl);
                // Update the file name with highlighted text
                fileItem.querySelector('.file-name').innerHTML = highlightText(fileName, searchQuery);
                filesSection.appendChild(fileItem);
            });
            searchContent.appendChild(filesSection);
        }

        // Show files in folders
        if (items.folderFiles.length > 0) {
            const folderFilesSection = document.createElement('div');
            folderFilesSection.className = 'search-category';
            folderFilesSection.innerHTML = `<h3>Files in Folders (${items.folderFiles.length})</h3>`;
            items.folderFiles.forEach(({ file, folderName }) => {
                const fileUrl = `https://${bucketName}.s3.amazonaws.com/${file.Key}`;
                const fileName = getFileNameFromPath(file.Key);
                const fileItem = createFileItemElement(file.Key, fileUrl);
                // Add folder information
                const folderInfo = document.createElement('div');
                folderInfo.style.fontSize = '0.8rem';
                folderInfo.style.color = '#666';
                folderInfo.innerHTML = `in folder: ${folderName}`;
                fileItem.querySelector('.file-name').appendChild(folderInfo);
                // Update the file name with highlighted text
                fileItem.querySelector('.file-name').firstChild.textContent = fileName;
                fileItem.querySelector('.file-name').firstChild.innerHTML = highlightText(fileName, searchQuery);
                folderFilesSection.appendChild(fileItem);
            });
            searchContent.appendChild(folderFilesSection);
        }
    } catch (error) {
        console.error('Error performing search:', error);
        searchContent.innerHTML = '<div class="no-results">Error performing search. Please try again.</div>';
    }
}

// Update search bar event listener
document.querySelector('.search-bar').addEventListener('input', (e) => {
    const searchQuery = e.target.value.trim();
    if (searchQuery) {
        performSearch(searchQuery);
    } else {
        // Clear search and show main content
        document.querySelector('.search-results').classList.remove('active');
        document.querySelector('.main-content').style.display = 'block';
    }
});

// Add clear search button handler
document.querySelector('.clear-search').addEventListener('click', () => {
    const searchBar = document.querySelector('.search-bar');
    searchBar.value = '';
    document.querySelector('.search-results').classList.remove('active');
    document.querySelector('.main-content').style.display = 'block';
});

// Function to show toast notifications
function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Function to show room modal
function showRoomModal() {
    const modal = document.getElementById('roomModal');
    modal.classList.add('active');
}

// Function to close room modal
function closeRoomModal() {
    const modal = document.getElementById('roomModal');
    modal.classList.remove('active');
    document.getElementById('createRoomForm').reset();
}



// Function to create room item element
function createRoomItemElement(room) {
    const roomItem = document.createElement('div');
    roomItem.className = 'room-item';
    roomItem.setAttribute('data-room-id', room.id);

    const roomHeader = document.createElement('div');
    roomHeader.className = 'room-header';

    const roomIcon = document.createElement('div');
    roomIcon.className = 'room-icon';
    roomIcon.textContent = '👥';

    const roomName = document.createElement('div');
    roomName.className = 'room-name';
    roomName.textContent = room.name;

    roomHeader.appendChild(roomIcon);
    roomHeader.appendChild(roomName);

    const roomDescription = document.createElement('div');
    roomDescription.className = 'room-description';
    roomDescription.textContent = room.description || 'No description';

    const roomMembers = document.createElement('div');
    roomMembers.className = 'room-members';
    room.members.forEach(member => {
        const memberAvatar = document.createElement('div');
        memberAvatar.className = 'member-avatar';
        memberAvatar.title = member.email;
        memberAvatar.textContent = member.email[0].toUpperCase();
        roomMembers.appendChild(memberAvatar);
    });

    roomItem.appendChild(roomHeader);
    roomItem.appendChild(roomDescription);
    roomItem.appendChild(roomMembers);

    // Check if current user is owner
    const currentUser = firebase.auth().currentUser;
    const isOwner = room.members.some(m => m.id === currentUser.uid && m.role === 'owner');

    if (isOwner) {
        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = '🗑️ Delete Room';
        deleteBtn.style.marginTop = '10px';
        deleteBtn.style.padding = '0.5rem';
        deleteBtn.style.border = 'none';
        deleteBtn.style.backgroundColor = '#f44336';
        deleteBtn.style.color = 'white';
        deleteBtn.style.borderRadius = '4px';
        deleteBtn.style.cursor = 'pointer';

        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const confirmation = prompt(`Type the room name "${room.name}" to confirm deletion:`);

            if (confirmation === room.name) {
                try {
                    await deleteRoom(room.id);
                    showToast(`Room "${room.name}" deleted successfully.`);
                    loadRooms(); // Refresh UI
                } catch (error) {
                    console.error('Failed to delete room:', error);
                    alert('Failed to delete room: ' + error.message);
                }
            } else {
                alert('Room name did not match. Deletion cancelled.');
            }
        });

        roomItem.appendChild(deleteBtn);
    }

    // Add click handler to open room
    roomItem.addEventListener('click', () => openRoom(room));

    return roomItem;
}


// Function to load rooms
async function loadRooms() {
    const roomsGrid = document.querySelector('.rooms-grid');
    roomsGrid.innerHTML = '<div class="loading-spinner"></div>';

    try {
        const user = firebase.auth().currentUser;
        if (!user) throw new Error('User not authenticated');

        // Fetch rooms index
        let rooms = [];
        try {
            const response = await s3.getObject({
                Bucket: bucketName,
                Key: 'rooms/index.json'
            }).promise();
            rooms = JSON.parse(response.Body.toString());
        } catch (err) {
            if (err.code === 'NoSuchKey') {
                rooms = [];
            } else {
                throw err;
            }
        }

        // Filter rooms for current user
        const userRooms = rooms.filter(room => {
            // Check if user is a member
            const isMember = room.members.some(member => {
                // Check by Firebase UID
                if (member.id === user.uid) return true;

                // Check by email
                if (member.email === user.email) return true;

                // Check pending invitations
                if (member.id && member.id.startsWith('pending_') && member.email === user.email) return true;

                return false;
            });

            return isMember;
        });

        roomsGrid.innerHTML = ''; // clear loader

        if (userRooms.length === 0) {
            roomsGrid.innerHTML = '<div style="color: #666;">You are not a member of any rooms.</div>';
            return;
        }

        // Sort rooms by creation date (newest first)
        userRooms.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        // Render each room card
        userRooms.forEach(room => {
            const roomItem = createRoomItemElement(room);
            roomsGrid.appendChild(roomItem);
        });

        // Process any pending invitations
        await processPendingInvitations(user);

    } catch (error) {
        console.error('Error loading rooms:', error);
        roomsGrid.innerHTML = '<div style="color: red;">Failed to load rooms.</div>';
    }
}


// Function to create a new room
async function createRoom(name, description, invitedEmails) {
    try {
        // Get current user
        const user = firebase.auth().currentUser;
        if (!user) {
            throw new Error('Not authenticated');
        }

        // Generate room ID
        const roomId = 'room_' + Date.now();

        // Create room object
        const room = {
            id: roomId,
            name: name,
            description: description,
            createdAt: new Date().toISOString(),
            createdBy: user.uid,
            members: [{
                id: user.uid,
                email: user.email,
                displayName: user.displayName || user.email.split('@')[0],
                role: 'owner',
                joinedAt: new Date().toISOString()
            }]
        };

        // Add invited members
        if (invitedEmails) {
            const emails = invitedEmails.split(',').map(email => email.trim());
            for (const email of emails) {
                if (email && email !== user.email) {
                    const userData = await getUserByEmail(email);
                    if (userData) {
                        // Add member with complete user data
                        room.members.push({
                            id: userData.id,
                            email: email,
                            displayName: userData.displayName,
                            role: 'member',
                            joinedAt: new Date().toISOString()
                        });
                    } else {
                        room.members.push({
                            id: `pending_${Date.now()}`,
                            email: email,
                            role: 'member',
                            status: 'pending',
                            invitedAt: new Date().toISOString(),
                            invitedBy: user.email
                        });

                        const pendingInvitationsKey = `pending_invitations/${email}.json`;
                        let invitations = [];
                        try {
                            const response = await s3.getObject({
                                Bucket: bucketName,
                                Key: pendingInvitationsKey
                            }).promise();
                            invitations = JSON.parse(response.Body.toString());
                        } catch (error) {
                            if (error.code !== 'NoSuchKey') throw error;
                        }

                        invitations.push({
                            roomId,
                            roomName: name,
                            role: 'member',
                            invitedAt: new Date().toISOString(),
                            invitedBy: user.email
                        });

                        await s3.putObject({
                            Bucket: bucketName,
                            Key: pendingInvitationsKey,
                            Body: JSON.stringify(invitations),
                            ContentType: 'application/json'
                        }).promise();
                    }
                }
            }
        }

        // Get existing rooms index
        let rooms = [];
        try {
            const response = await s3.getObject({
                Bucket: bucketName,
                Key: 'rooms/index.json'
            }).promise();
            rooms = JSON.parse(response.Body.toString());
        } catch (error) {
            if (error.code !== 'NoSuchKey') {
                throw error;
            }
        }

        // Add new room to index
        rooms.push(room);

        // Save updated rooms index
        await s3.putObject({
            Bucket: bucketName,
            Key: 'rooms/index.json',
            Body: JSON.stringify(rooms),
            ContentType: 'application/json'
        }).promise();

        // Save room metadata
        await s3.putObject({
            Bucket: bucketName,
            Key: `rooms/${roomId}/metadata.json`,
            Body: JSON.stringify(room),
            ContentType: 'application/json'
        }).promise();

        // Create room directory
        await s3.putObject({
            Bucket: bucketName,
            Key: `rooms/${roomId}/`,
            Body: ''
        }).promise();

        // Create files directory
        await s3.putObject({
            Bucket: bucketName,
            Key: `rooms/${roomId}/files/`,
            Body: ''
        }).promise();

        // Create empty activity log
        await s3.putObject({
            Bucket: bucketName,
            Key: `rooms/${roomId}/activity_log.json`,
            Body: JSON.stringify([{
                type: 'ROOM_CREATED',
                timestamp: new Date().toISOString(),
                performedBy: user.email,
                details: {
                    name: name,
                    description: description
                }
            }]),
            ContentType: 'application/json'
        }).promise();

        // Refresh rooms list
        await loadRooms();
        return true;
    } catch (error) {
        console.error('Error creating room:', error);
        throw error;
    }
}



// Function to open a room
async function openRoom(room) {
    try {
        // Get current user
        const user = firebase.auth().currentUser;
        if (!user) {
            throw new Error('Not authenticated');
        }

        // Check if user is a member
        const member = room.members.find(m => m.id === user.uid);
        if (!member) {
            throw new Error('Access denied');
        }

        // Redirect to room page
        window.location.href = `room.html?id=${room.id}`;

    } catch (error) {
        console.error('Error opening room:', error);
        showToast(error.message, 'error');
    }
}

// Add room creation form handler
document.getElementById('createRoomForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const form = e.target;
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;

    try {
        const name = document.getElementById('roomName').value.trim();
        const description = document.getElementById('roomDescription').value.trim();
        const invitedEmails = document.getElementById('inviteEmails').value.trim();

        await createRoom(name, description, invitedEmails);
        closeRoomModal();

        // Show success message
        alert('Room created successfully!');
    } catch (error) {
        console.error('Error creating room:', error);
        alert('Failed to create room: ' + error.message);
    } finally {
        submitButton.disabled = false;
    }
});

// Add click handler for create room button
document.querySelector('.create-room-btn').addEventListener('click', showRoomModal);
document.querySelector('.cancel-btn').addEventListener('click', closeRoomModal);

// Add styles for room info
const roomStyles = document.createElement('style');
roomStyles.textContent = `
    .room-info {
        background-color: #f8f9fa;
        border-radius: 8px;
        padding: 1rem;
        margin: 1rem 0;
    }

    .room-info .room-description {
        margin-bottom: 0.5rem;
        color: #666;
    }

    .room-info .room-members {
        font-size: 0.9rem;
        color: #333;
    }
`;
document.head.appendChild(roomStyles);

// Function to check user permissions in a room
function getUserPermissions(room, userId) {
    const member = room.members.find(m => m.id === userId);
    if (!member) return null;
    return ROLE_PERMISSIONS[member.role] || ROLE_PERMISSIONS[ROOM_ROLES.VIEWER];
}

// Function to create room settings modal
function createRoomSettingsModal(room) {
    const modal = document.createElement('div');
    modal.className = 'modal room-settings-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h2>Room Settings</h2>
                <button class="close-btn">×</button>
            </div>
            <div class="modal-body">
                <div class="settings-tabs">
                    <button class="tab-btn active" data-tab="general">General</button>
                    <button class="tab-btn" data-tab="members">Members</button>
                    <button class="tab-btn" data-tab="activity">Activity</button>
                </div>
                <div class="tab-content">
                    <div class="tab-pane active" id="general">
                        <form id="roomSettingsForm">
                            <div class="form-group">
                                <label for="editRoomName">Room Name</label>
                                <input type="text" id="editRoomName" value="${room.name}" required>
                            </div>
                            <div class="form-group">
                                <label for="editRoomDescription">Description</label>
                                <textarea id="editRoomDescription">${room.description || ''}</textarea>
                            </div>
                            <div class="form-group">
                                <label>Room ID</label>
                                <div class="room-id">${room.id}</div>
                            </div>
                            <div class="form-group">
                                <label>Created By</label>
                                <div>${room.members.find(m => m.role === 'owner')?.email || 'Unknown'}</div>
                            </div>
                            <div class="form-group">
                                <label>Created At</label>
                                <div>${new Date(room.createdAt).toLocaleString()}</div>
                            </div>
                        </form>
                    </div>
                    <div class="tab-pane" id="members">
                        <div class="members-list">
                            ${room.members.map(member => `
                                <div class="member-item" data-email="${member.email}">
                                    <div class="member-info">
                                        <div class="member-avatar">${member.email[0].toUpperCase()}</div>
                                        <div class="member-details">
                                            <div class="member-email">${member.email}</div>
                                            <div class="member-role">${member.role}</div>
                                        </div>
                                    </div>
                                    <div class="member-actions">
                                        ${member.role !== 'owner' ? `
                                            <select class="role-select" ${getUserPermissions(room, firebase.auth().currentUser.uid)?.canManageRoles ? '' : 'disabled'}>
                                                ${Object.values(ROOM_ROLES).map(role =>
        `<option value="${role}" ${member.role === role ? 'selected' : ''}>${role}</option>`
    ).join('')}
                                            </select>
                                            <button class="remove-member-btn" ${getUserPermissions(room, firebase.auth().currentUser.uid)?.canRemoveMembers ? '' : 'disabled'}>
                                                <span class="icon">🗑️</span>
                                            </button>
                                        ` : ''}
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                        <div class="invite-section">
                            <h3>Invite Members</h3>
                            <div class="form-group">
                                <input type="email" id="inviteEmail" placeholder="Enter email address">
                                <select id="inviteRole">
                                    ${Object.values(ROOM_ROLES).filter(role => role !== 'owner').map(role =>
        `<option value="${role}">${role}</option>`
    ).join('')}
                                </select>
                                <button id="sendInviteBtn">Send Invite</button>
                            </div>
                        </div>
                    </div>
                    <div class="tab-pane" id="activity">
                        <div class="activity-list">
                            <!-- Activity items will be loaded dynamically -->
                            <div class="loading-spinner"></div>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    ${getUserPermissions(room, firebase.auth().currentUser.uid)?.canDelete ?
            `<button class="delete-room-btn">Delete Room</button>` : ''}
                    <button class="save-settings-btn">Save Changes</button>
                </div>
            </div>
        </div>
    `;

    // Add event listeners
    const closeBtn = modal.querySelector('.close-btn');
    closeBtn.addEventListener('click', () => {
        modal.classList.remove('active');
        setTimeout(() => modal.remove(), 300);
    });

    // Tab switching
    const tabBtns = modal.querySelectorAll('.tab-btn');
    const tabPanes = modal.querySelectorAll('.tab-pane');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.dataset.tab;
            tabBtns.forEach(b => b.classList.remove('active'));
            tabPanes.forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            modal.querySelector(`#${tabName}`).classList.add('active');
        });
    });

    // Role change handlers
    const roleSelects = modal.querySelectorAll('.role-select');
    roleSelects.forEach(select => {
        select.addEventListener('change', async (e) => {
            const memberEmail = e.target.closest('.member-item').dataset.email;
            const newRole = e.target.value;
            try {
                await updateMemberRole(room.id, memberEmail, newRole);
                showToast('Member role updated successfully');
            } catch (error) {
                console.error('Error updating member role:', error);
                showToast('Failed to update member role', 'error');
                e.target.value = room.members.find(m => m.email === memberEmail).role;
            }
        });
    });

    // Remove member handlers
    const removeBtns = modal.querySelectorAll('.remove-member-btn');
    removeBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
            const memberEmail = btn.closest('.member-item').dataset.email;
            if (confirm(`Are you sure you want to remove ${memberEmail} from the room?`)) {
                try {
                    await removeMemberFromRoom(room.id, memberEmail);
                    btn.closest('.member-item').remove();
                    showToast('Member removed successfully');
                } catch (error) {
                    console.error('Error removing member:', error);
                    showToast('Failed to remove member', 'error');
                }
            }
        });
    });

    // Invite member handler
    const sendInviteBtn = modal.querySelector('#sendInviteBtn');
    const inviteEmailInput = modal.querySelector('#inviteEmail');
    const inviteRoleSelect = modal.querySelector('#inviteRole');

    sendInviteBtn.addEventListener('click', async () => {
        const email = inviteEmailInput.value.trim();
        const role = inviteRoleSelect.value;

        if (!email) {
            showToast('Please enter an email address', 'error');
            return;
        }

        try {
            await inviteMemberToRoom(room.id, email, role);
            inviteEmailInput.value = '';
            showToast('Invitation sent successfully');
            await loadRooms(); // Refresh room list
        } catch (error) {
            console.error('Error inviting member:', error);
            showToast('Failed to send invitation', 'error');
        }
    });

    // Save settings handler
    const saveBtn = modal.querySelector('.save-settings-btn');
    saveBtn.addEventListener('click', async () => {
        const newName = modal.querySelector('#editRoomName').value.trim();
        const newDescription = modal.querySelector('#editRoomDescription').value.trim();

        if (!newName) {
            showToast('Room name is required', 'error');
            return;
        }

        try {
            await updateRoomSettings(room.id, {
                name: newName,
                description: newDescription
            });
            showToast('Room settings updated successfully');
            await loadRooms(); // Refresh room list
            modal.classList.remove('active');
            setTimeout(() => modal.remove(), 300);
        } catch (error) {
            console.error('Error updating room settings:', error);
            showToast('Failed to update room settings', 'error');
        }
    });

    // Delete room handler
    const deleteBtn = modal.querySelector('.delete-room-btn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
            if (confirm('Are you sure you want to delete this room? This action cannot be undone.')) {
                try {
                    await deleteRoom(room.id);
                    showToast('Room deleted successfully');
                    await loadRooms(); // Refresh room list
                    modal.classList.remove('active');
                    setTimeout(() => modal.remove(), 300);
                } catch (error) {
                    console.error('Error deleting room:', error);
                    showToast('Failed to delete room', 'error');
                }
            }
        });
    }

    // Load activity log
    loadRoomActivity(room.id, modal.querySelector('.activity-list'));

    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add('active'), 0);
}

// Function to update member role
async function updateMemberRole(roomId, memberEmail, newRole) {
    try {
        const room = await getRoomData(roomId);
        const memberIndex = room.members.findIndex(m => m.email === memberEmail);
        if (memberIndex === -1) throw new Error('Member not found');

        room.members[memberIndex].role = newRole;
        await updateRoomData(roomId, room);

        // Log activity
        await logRoomActivity(roomId, {
            type: 'ROLE_CHANGE',
            memberEmail,
            newRole,
            timestamp: new Date().toISOString(),
            performedBy: firebase.auth().currentUser.email
        });
    } catch (error) {
        console.error('Error updating member role:', error);
        throw error;
    }
}

// Function to remove member from room
async function removeMemberFromRoom(roomId, memberEmail) {
    try {
        const room = await getRoomData(roomId);
        room.members = room.members.filter(m => m.email !== memberEmail);
        await updateRoomData(roomId, room);

        // Log activity
        await logRoomActivity(roomId, {
            type: 'MEMBER_REMOVED',
            memberEmail,
            timestamp: new Date().toISOString(),
            performedBy: firebase.auth().currentUser.email
        });
    } catch (error) {
        console.error('Error removing member:', error);
        throw error;
    }
}

// Function to invite member to room
async function inviteMemberToRoom(roomId, email, role) {
    try {
        const room = await getRoomData(roomId);
        if (room.members.some(m => m.email === email)) {
            throw new Error('Member already exists in the room');
        }

        // Get user data
        const userData = await getUserByEmail(email);

        // Create pending invitation if user hasn't logged in yet
        if (!userData) {
            // Add member with pending status
            room.members.push({
                id: `pending_${Date.now()}`, // Temporary ID for pending users
                email: email,
                role: role,
                status: 'pending',
                invitedAt: new Date().toISOString(),
                invitedBy: firebase.auth().currentUser.email
            });

            await updateRoomData(roomId, room);

            // Log activity
            await logRoomActivity(roomId, {
                type: 'MEMBER_INVITED',
                memberEmail: email,
                status: 'pending',
                role,
                timestamp: new Date().toISOString(),
                performedBy: firebase.auth().currentUser.email
            });

            // Store invitation in pending invitations
            const pendingInvitationsKey = `pending_invitations/${email}.json`;
            let invitations = [];
            try {
                const response = await s3.getObject({
                    Bucket: bucketName,
                    Key: pendingInvitationsKey
                }).promise();
                invitations = JSON.parse(response.Body.toString());
            } catch (error) {
                if (error.code !== 'NoSuchKey') throw error;
            }

            invitations.push({
                roomId,
                roomName: room.name,
                role,
                invitedAt: new Date().toISOString(),
                invitedBy: firebase.auth().currentUser.email
            });

            await s3.putObject({
                Bucket: bucketName,
                Key: pendingInvitationsKey,
                Body: JSON.stringify(invitations),
                ContentType: 'application/json'
            }).promise();

            return;
        }

        // Add member with complete user data
        room.members.push({
            id: userData.id,
            email: userData.email,
            displayName: userData.displayName,
            role: role,
            invitedAt: new Date().toISOString(),
            invitedBy: firebase.auth().currentUser.email
        });

        await updateRoomData(roomId, room);

        // Log activity
        await logRoomActivity(roomId, {
            type: 'MEMBER_INVITED',
            memberEmail: email,
            memberId: userData.id,
            role,
            timestamp: new Date().toISOString(),
            performedBy: firebase.auth().currentUser.email
        });

        // Create notification for invited user
        await createUserNotification(userData.id, {
            type: 'ROOM_INVITATION',
            roomId: roomId,
            roomName: room.name,
            invitedBy: firebase.auth().currentUser.email,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error inviting member:', error);
        throw error;
    }
}

// Function to update room settings
async function updateRoomSettings(roomId, settings) {
    try {
        const room = await getRoomData(roomId);
        Object.assign(room, settings);
        await updateRoomData(roomId, room);

        // Log activity
        await logRoomActivity(roomId, {
            type: 'SETTINGS_UPDATED',
            changes: settings,
            timestamp: new Date().toISOString(),
            performedBy: firebase.auth().currentUser.email
        });
    } catch (error) {
        console.error('Error updating room settings:', error);
        throw error;
    }
}

// Function to delete room
async function deleteRoom(roomId) {
    try {
        // Get the index of all rooms
        const response = await s3.getObject({
            Bucket: bucketName,
            Key: 'rooms/index.json'
        }).promise();

        let rooms = JSON.parse(response.Body.toString());
        const updatedRooms = rooms.filter(r => r.id !== roomId);

        // Update the rooms index
        await s3.putObject({
            Bucket: bucketName,
            Key: 'rooms/index.json',
            Body: JSON.stringify(updatedRooms),
            ContentType: 'application/json'
        }).promise();

        // Optionally, delete room folder (optional cleanup)
        const roomPrefix = `rooms/${roomId}/`;
        const roomObjects = await s3.listObjects({ Bucket: bucketName, Prefix: roomPrefix }).promise();

        for (const obj of roomObjects.Contents) {
            await s3.deleteObject({ Bucket: bucketName, Key: obj.Key }).promise();
        }

    } catch (error) {
        console.error('Error deleting room:', error);
        throw error;
    }
}


// Function to get room data
async function getRoomData(roomId) {
    try {
        const response = await s3.getObject({
            Bucket: bucketName,
            Key: `rooms/${roomId}/metadata.json`
        }).promise();

        return JSON.parse(response.Body.toString());
    } catch (error) {
        console.error('Error getting room data:', error);
        throw error;
    }
}

// Function to update room data
async function updateRoomData(roomId, data) {
    try {
        await s3.putObject({
            Bucket: bucketName,
            Key: `rooms/${roomId}/metadata.json`,
            Body: JSON.stringify(data),
            ContentType: 'application/json'
        }).promise();
    } catch (error) {
        console.error('Error updating room data:', error);
        throw error;
    }
}

// Function to log room activity
async function logRoomActivity(roomId, activity) {
    try {
        const logKey = `rooms/${roomId}/activity_log.json`;
        let activities = [];

        // Try to get existing log
        try {
            const existing = await s3.getObject({
                Bucket: bucketName,
                Key: logKey
            }).promise();
            activities = JSON.parse(existing.Body.toString());
        } catch (error) {
            // If no log exists, start with empty array
            if (error.code !== 'NoSuchKey') throw error;
        }

        // Add new activity
        activities.push(activity);

        // Keep only last 100 activities
        if (activities.length > 100) {
            activities = activities.slice(-100);
        }

        // Save updated log
        await s3.putObject({
            Bucket: bucketName,
            Key: logKey,
            Body: JSON.stringify(activities),
            ContentType: 'application/json'
        }).promise();
    } catch (error) {
        console.error('Error logging activity:', error);
        throw error;
    }
}

// Function to load room activity
async function loadRoomActivity(roomId, container) {
    try {
        const logKey = `rooms/${roomId}/activity_log.json`;
        let activities = [];

        try {
            const response = await s3.getObject({
                Bucket: bucketName,
                Key: logKey
            }).promise();
            activities = JSON.parse(response.Body.toString());
        } catch (error) {
            if (error.code !== 'NoSuchKey') throw error;
        }

        // Clear container and remove loading spinner
        container.innerHTML = '';

        if (activities.length === 0) {
            container.innerHTML = '<div class="no-activity">No activity recorded yet</div>';
            return;
        }

        // Sort activities by timestamp, newest first
        activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        // Create activity items
        activities.forEach(activity => {
            const item = document.createElement('div');
            item.className = 'activity-item';

            const icon = getActivityIcon(activity.type);
            const time = new Date(activity.timestamp).toLocaleString();
            const description = getActivityDescription(activity);

            item.innerHTML = `
                <div class="activity-icon">${icon}</div>
                <div class="activity-content">
                    <div class="activity-description">${description}</div>
                    <div class="activity-time">${time}</div>
                </div>
            `;

            container.appendChild(item);
        });
    } catch (error) {
        console.error('Error loading activity:', error);
        container.innerHTML = '<div class="error">Failed to load activity log</div>';
    }
}

// Helper function to get activity icon
function getActivityIcon(type) {
    switch (type) {
        case 'MEMBER_INVITED': return '👋';
        case 'MEMBER_REMOVED': return '🚫';
        case 'ROLE_CHANGE': return '👑';
        case 'SETTINGS_UPDATED': return '⚙️';
        case 'FILE_UPLOADED': return '📤';
        case 'FILE_DELETED': return '🗑️';
        case 'FILE_RENAMED': return '✏️';
        case 'ROOM_DELETED': return '❌';
        default: return '📝';
    }
}

// Helper function to get activity description
function getActivityDescription(activity) {
    switch (activity.type) {
        case 'MEMBER_INVITED':
            return `${activity.performedBy} invited ${activity.memberEmail} as ${activity.role}`;
        case 'MEMBER_REMOVED':
            return `${activity.performedBy} removed ${activity.memberEmail}`;
        case 'ROLE_CHANGE':
            return `${activity.performedBy} changed ${activity.memberEmail}'s role to ${activity.newRole}`;
        case 'SETTINGS_UPDATED':
            return `${activity.performedBy} updated room settings`;
        case 'FILE_UPLOADED':
            return `${activity.performedBy} uploaded ${activity.fileName}`;
        case 'FILE_DELETED':
            return `${activity.performedBy} deleted ${activity.fileName}`;
        case 'FILE_RENAMED':
            return `${activity.performedBy} renamed ${activity.oldFileName} to ${activity.newFileName}`;
        case 'ROOM_DELETED':
            return `${activity.performedBy} deleted the room`;
        default:
            return 'Unknown activity';
    }
}

// Add settings button to room items
function addRoomSettingsButton(roomItem, room) {
    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'room-settings-btn';
    settingsBtn.innerHTML = '⚙️';
    settingsBtn.title = 'Room Settings';

    settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent room from opening
        createRoomSettingsModal(room);
    });

    roomItem.querySelector('.room-header').appendChild(settingsBtn);
}

// Modify createRoomItemElement to include settings button
const originalCreateRoomItemElement = createRoomItemElement;
createRoomItemElement = function (room) {
    const roomItem = originalCreateRoomItemElement(room);

    // Add settings button if user has permission
    const permissions = getUserPermissions(room, firebase.auth().currentUser.uid);
    if (permissions?.canEdit) {
        addRoomSettingsButton(roomItem, room);
    }

    return roomItem;
};

// Function to get user data by email
async function getUserByEmail(email) {
    try {
        // Get user from Firebase Auth
        const userRecord = await firebase.auth().fetchSignInMethodsForEmail(email);
        if (!userRecord || userRecord.length === 0) {
            return null;
        }

        // Get user data from S3 (for additional data like displayName)
        let userData = null;
        try {
            const response = await s3.getObject({
                Bucket: bucketName,
                Key: 'users/index.json'
            }).promise();
            const users = JSON.parse(response.Body.toString());
            userData = users[email];
        } catch (error) {
            if (error.code !== 'NoSuchKey') {
                console.error('Error getting user data from S3:', error);
            }
        }

        // Return combined data
        return {
            id: userData?.id || email, // Use email as fallback ID
            email: email,
            displayName: userData?.displayName || email.split('@')[0],
            lastLogin: userData?.lastLogin || new Date().toISOString()
        };
    } catch (error) {
        console.error('Error getting user data:', error);
        throw error;
    }
}

// Function to update user index
async function updateUserIndex(userData) {
    try {
        // Get current index
        let users = {};
        try {
            const response = await s3.getObject({
                Bucket: bucketName,
                Key: 'users/index.json'
            }).promise();
            users = JSON.parse(response.Body.toString());
        } catch (error) {
            if (error.code !== 'NoSuchKey') throw error;
        }

        // Update user data
        users[userData.email] = userData;

        // Save updated index
        await s3.putObject({
            Bucket: bucketName,
            Key: 'users/index.json',
            Body: JSON.stringify(users),
            ContentType: 'application/json'
        }).promise();
    } catch (error) {
        console.error('Error updating user index:', error);
        throw error;
    }
}

// Function to create user notification
async function createUserNotification(userId, notification) {
    try {
        const notificationsKey = `users/${userId}/notifications.json`;
        let notifications = [];

        // Try to get existing notifications
        try {
            const response = await s3.getObject({
                Bucket: bucketName,
                Key: notificationsKey
            }).promise();
            notifications = JSON.parse(response.Body.toString());
        } catch (error) {
            if (error.code !== 'NoSuchKey') throw error;
        }

        // Add new notification
        notifications.unshift(notification);

        // Keep only last 50 notifications
        if (notifications.length > 50) {
            notifications = notifications.slice(0, 50);
        }

        // Save notifications
        await s3.putObject({
            Bucket: bucketName,
            Key: notificationsKey,
            Body: JSON.stringify(notifications),
            ContentType: 'application/json'
        }).promise();
    } catch (error) {
        console.error('Error creating notification:', error);
        throw error;
    }
}



